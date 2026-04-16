/**
 * tools/auth.mjs — Auth helpers for feishu-skills APP.
 *
 * Loads token-utils / send-card from the vendored legacy tree at
 * tools/legacy/feishu-auth/. FEISHU_LEGACY_AUTH_DIR env var is still
 * honored as an escape hatch (e.g. testing an out-of-tree auth impl).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveLegacyAuthDir() {
  const fromEnv = process.env.FEISHU_LEGACY_AUTH_DIR;
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'token-utils.mjs'))) return fromEnv;

  const vendored = path.resolve(__dirname, 'legacy', 'feishu-auth');
  if (fs.existsSync(path.join(vendored, 'token-utils.mjs'))) return vendored;

  throw new Error(
    `Cannot locate feishu-auth helpers. Expected at ${vendored} (vendored) ` +
    `or override via FEISHU_LEGACY_AUTH_DIR.`,
  );
}

const LEGACY_AUTH_DIR = resolveLegacyAuthDir();

// Re-export pure token utilities (no CLI side effects)
const tokenUtils = await import(
  /* @vite-ignore */
  'file://' + path.join(LEGACY_AUTH_DIR, 'token-utils.mjs').replace(/\\/g, '/')
);

const sendCard = await import(
  /* @vite-ignore */
  'file://' + path.join(LEGACY_AUTH_DIR, 'send-card.mjs').replace(/\\/g, '/')
);

export const {
  getConfig,
  getTokenFilePath,
  readToken,
  saveToken,
  deleteToken,
  getValidToken,
} = tokenUtils;

export const { getTenantAccessToken } = sendCard;

/**
 * Run `node auth.js --auth-and-poll` as a subprocess and wait for completion.
 *
 * Returns:
 *   {status: 'authorized', ...}      — user authorized successfully
 *   {status: 'expired', ...}         — auth code expired
 *   {status: 'denied', ...}          — user denied
 *   {status: 'error', message}       — other failures
 *
 * Exit code 0 = authorized; non-zero = any other status.
 */
export async function authAndPoll({ openId, chatId, timeoutMs, scope }) {
  const authJsPath = path.join(LEGACY_AUTH_DIR, 'auth.mjs');

  const args = ['--auth-and-poll', '--open-id', openId];
  if (chatId) args.push('--chat-id', chatId);
  if (timeoutMs) args.push('--timeout', String(Math.floor(timeoutMs / 1000)));
  if (scope) args.push('--scope', scope);

  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [authJsPath, ...args], {
      cwd: LEGACY_AUTH_DIR,
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      // auth.mjs writes single-line JSON to stdout (last line).
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop() || '';
      let parsed = null;
      try {
        parsed = JSON.parse(lastLine);
      } catch {
        // ignore
      }
      if (parsed) {
        resolve(parsed);
        return;
      }
      resolve({
        status: 'error',
        message: `auth subprocess exited ${code} with non-JSON output. stderr: ${stderr.slice(0, 500)}`,
      });
    });

    proc.on('error', (err) => {
      resolve({ status: 'error', message: `Failed to spawn auth subprocess: ${err.message}` });
    });
  });
}

export { LEGACY_AUTH_DIR };
