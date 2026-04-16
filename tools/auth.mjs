/**
 * tools/auth.mjs — Auth helpers for feishu-skills APP.
 *
 * Strategy: re-export token utilities from the legacy feishu-skills repo
 * (battle-tested, no need to fork) and provide a callable wrapper around
 * the existing `auth.js --auth-and-poll` CLI.
 *
 * If the legacy path is not available, set FEISHU_LEGACY_AUTH_DIR env var.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the legacy feishu-auth directory (where token-utils.mjs and auth.js live).
 * Order:
 *   1. FEISHU_LEGACY_AUTH_DIR env var
 *   2. ../feishu-skills/feishu-auth (sibling to feishu-skills-app)
 *   3. ../../feishu-skills/feishu-auth
 */
function resolveLegacyAuthDir() {
  const fromEnv = process.env.FEISHU_LEGACY_AUTH_DIR;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = [
    path.resolve(__dirname, '..', '..', 'feishu-skills', 'feishu-auth'),
    path.resolve(__dirname, '..', '..', '..', 'feishu-skills', 'feishu-auth'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'token-utils.mjs'))) return c;
  }
  throw new Error(
    `Cannot locate legacy feishu-auth dir. Set FEISHU_LEGACY_AUTH_DIR. Tried: ${candidates.join(', ')}`,
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
