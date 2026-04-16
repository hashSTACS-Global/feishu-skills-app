/**
 * tools/legacy-adapter.mjs — Generic adapter to invoke any legacy
 * feishu-skills/<skill>/<script>.mjs as a subprocess.
 *
 * Why this works without re-auth:
 *   _constructor has already cached/refreshed the user's token to the
 *   shared encrypted store (LOCALAPPDATA/openclaw-feishu-uat/...). Legacy
 *   scripts call `getValidToken(openId, appId, appSecret)` which reads
 *   the same store, so they pick up the token transparently.
 *
 * Arg mapping:
 *   input.foo_bar       -> --foo-bar <value>
 *   input.flag (true)   -> --flag           (bare flag, no value)
 *   input.obj/array     -> --obj '<json>'   (serialized as JSON string)
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveLegacyDir(skillDirName) {
  const fromEnv = process.env.FEISHU_LEGACY_SKILLS_DIR;
  if (fromEnv) {
    const p = path.join(fromEnv, skillDirName);
    if (fs.existsSync(p)) return p;
  }
  const candidates = [
    path.resolve(__dirname, '..', '..', 'feishu-skills', skillDirName),
    path.resolve(__dirname, '..', '..', '..', 'feishu-skills', skillDirName),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error(`Cannot locate legacy skill dir: ${skillDirName}`);
}

function snakeToKebab(s) {
  return s.replace(/_/g, '-');
}

function inputToArgs(input, opts = {}) {
  const args = [];
  const skip = new Set(opts.skip || []);
  for (const [key, value] of Object.entries(input || {})) {
    if (skip.has(key)) continue;
    if (value === undefined || value === null) continue;
    const flag = '--' + snakeToKebab(key);
    if (value === true) {
      args.push(flag);
      continue;
    }
    if (value === false) continue;
    if (typeof value === 'object') {
      args.push(flag, JSON.stringify(value));
    } else {
      args.push(flag, String(value));
    }
  }
  return args;
}

/**
 * Run a legacy script.
 *
 * @param {object} cfg
 *   - skillDir:    e.g. "feishu-create-doc"
 *   - script:      e.g. "create-doc.mjs"
 *   - input:       pipeline input object
 *   - skip?:       array of input keys to NOT pass as args (e.g. ['scope'])
 *   - timeoutMs?:  default 60000
 * @returns parsed stdout JSON (last line)
 */
export async function runLegacy({ skillDir, script, input, skip, timeoutMs = 60000 }) {
  const dir = resolveLegacyDir(skillDir);
  const scriptPath = path.join(dir, script);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Legacy script not found: ${scriptPath}`);
  }

  const args = inputToArgs(input, { skip: skip || ['scope', 'open_id'] });
  if (input?.open_id) {
    args.unshift('--open-id', input.open_id);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd: dir,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`legacy script timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      clearTimeout(timer);
      // Take the LAST non-empty line as the JSON result (legacy scripts
      // sometimes write multiple `out()` lines but the final one is the result).
      const lines = stdout.trim().split('\n').map(s => s.trim()).filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      let parsed = null;
      try { parsed = JSON.parse(lastLine); } catch {}
      if (code === 0) {
        if (parsed) return resolve(parsed);
        return reject(new Error(`legacy script exit 0 but stdout not JSON: ${lastLine.slice(0, 300)}`));
      }
      // Non-zero exit: legacy convention is JSON error on stdout.
      if (parsed) {
        const err = new Error(parsed.message || `legacy script exited ${code}`);
        err.code = parsed.error || 'legacy_error';
        err.legacyResult = parsed;
        return reject(err);
      }
      reject(new Error(`legacy script exited ${code}, stderr: ${stderr.slice(0, 500)}`));
    });
    proc.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`spawn failed: ${err.message}`));
    });
  });
}

/**
 * Build a complete execute.mjs handler — one-liner for new pipelines.
 *
 * Usage in a pipeline's steps/execute.mjs:
 *   import { stdinToOutput } from '../../../tools/legacy-adapter.mjs';
 *   await stdinToOutput({ skillDir: 'feishu-create-doc', script: 'create-doc.mjs' });
 */
export async function stdinToOutput({ skillDir, script, skip, timeoutMs }) {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw || '{}'); }
  catch (e) { return fail('invalid_input', `stdin not JSON: ${e.message}`); }

  try {
    const result = await runLegacy({
      skillDir,
      script,
      input: payload.input || {},
      skip,
      timeoutMs,
    });
    process.stdout.write(JSON.stringify({ output: result }));
  } catch (err) {
    const code = err.code || 'unexpected_error';
    const extra = err.legacyResult ? { ...err.legacyResult } : {};
    delete extra.error; delete extra.message;
    fail(code, err.message || String(err), extra);
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ error: code, message, ...extra }));
  process.exit(1);
}
