#!/usr/bin/env node
/**
 * _constructor / ensure_auth.mjs
 *
 * Framework-level auth step that runs before every business pipeline.
 *
 * Flow:
 *   1. Read input.open_id (and optional input.chat_id, scope)
 *   2. Try to fetch a valid token (cached + auto-refresh)
 *   3. If valid token exists → output it
 *   4. If missing/expired → call authAndPoll (sends card to user, blocks)
 *   5. After auth completes, fetch token again and output it
 *   6. On any failure → exit(1) with structured error JSON
 *
 * stdin:  { input: { open_id, chat_id?, scope? }, steps: {} }
 * stdout: { output: { access_token, open_id, scope } }
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { getConfig, getValidToken, authAndPoll } = await import(
  'file://' + path.join(TOOLS_DIR, 'auth.mjs').replace(/\\/g, '/')
);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ error: code, message, ...extra }));
  process.exit(1);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (e) {
    fail('invalid_input', `stdin is not valid JSON: ${e.message}`);
  }

  const input = payload.input || {};
  const openId = input.open_id;
  const chatId = input.chat_id || null;
  const scope = input.scope || null;

  if (!openId) {
    fail('missing_param', 'input.open_id is required');
  }

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    fail('config_error', err.message);
  }

  // Try cached + auto-refresh path first.
  // BUT: if input.scope is provided, we must let authAndPoll verify scope
  // coverage (it returns immediately if scopes are satisfied, otherwise
  // triggers re-auth with merged scopes).
  let token = null;
  if (!scope) {
    try {
      token = await getValidToken(openId, cfg.appId, cfg.appSecret);
    } catch (err) {
      process.stderr.write(`[ensure_auth] getValidToken error: ${err.message}\n`);
    }

    if (token) {
      emit({
        output: {
          access_token: token,
          open_id: openId,
          chat_id: chatId,
          source: 'cached',
        },
      });
      return;
    }
  }

  // Token missing/expired OR scope explicitly requested → defer to authAndPoll
  process.stderr.write(
    `[ensure_auth] ${token ? 'scope check' : 'no valid token'}, starting auth-and-poll${scope ? ` with scope=${scope}` : ''}\n`,
  );

  const timeoutMs = parseInt(process.env.FEISHU_AUTH_TIMEOUT_MS || '60000', 10);
  const result = await authAndPoll({ openId, chatId, timeoutMs, scope });

  if (result.status !== 'authorized') {
    fail(
      result.status === 'expired' ? 'auth_expired' :
      result.status === 'denied'  ? 'auth_denied'  : 'auth_failed',
      result.message || `auth failed with status: ${result.status}`,
      { auth_result: result },
    );
  }

  // Re-fetch the token now that auth is done
  let newToken;
  try {
    newToken = await getValidToken(openId, cfg.appId, cfg.appSecret);
  } catch (err) {
    fail('token_error', `Failed to read token after auth: ${err.message}`);
  }
  if (!newToken) {
    fail('token_error', 'Token was not persisted after authAndPoll completed');
  }

  emit({
    output: {
      access_token: newToken,
      open_id: openId,
      chat_id: chatId,
      source: 'fresh_auth',
    },
  });
}

main().catch(err => {
  fail('unexpected_error', err.message || String(err));
});
