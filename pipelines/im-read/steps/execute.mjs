#!/usr/bin/env node
/**
 * im-read / execute.mjs — dispatch im-read actions.
 *
 * - get_messages    : uses tenant_access_token (fetches via getTenantAccessToken)
 * - search_messages : uses user access_token from _constructor
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { getConfig, getTenantAccessToken } = await import(
  'file://' + path.join(TOOLS_DIR, 'auth.mjs').replace(/\\/g, '/')
);
const { getMessages, searchMessages, FeishuError } = await import(
  'file://' + path.join(TOOLS_DIR, 'lib', 'im-read.mjs').replace(/\\/g, '/')
);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', c => { data += c; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emit(o) { process.stdout.write(JSON.stringify(o)); }
function fail(code, message, extra = {}) {
  process.stdout.write(JSON.stringify({ error: code, message, ...extra }));
  process.exit(1);
}

async function main() {
  const raw = await readStdin();
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch (e) { fail('invalid_input', `stdin not JSON: ${e.message}`); }

  const input = payload.input || {};
  const userToken = payload.steps?._constructor?.output?.access_token;

  if (!input.action) fail('missing_param', 'input.action 必填 (get_messages | search_messages)');

  let cfg;
  try { cfg = getConfig(__dirname); } catch (err) { fail('config_error', err.message); }

  try {
    let result;
    if (input.action === 'get_messages') {
      const tenantToken = await getTenantAccessToken(cfg.appId, cfg.appSecret);
      result = await getMessages(input, tenantToken);
    } else if (input.action === 'search_messages') {
      if (!userToken) fail('missing_token', '_constructor did not provide access_token (required for search_messages)');
      result = await searchMessages(input, userToken);
    } else {
      fail('unsupported_action', `unsupported action: ${input.action}`);
    }
    emit({ output: result });
  } catch (err) {
    if (err instanceof FeishuError) {
      const extra = { ...err };
      delete extra.code; delete extra.message;
      fail(err.code, err.message, extra);
    }
    fail('unexpected_error', err.message || String(err));
  }
}

main().catch(err => fail('unexpected_error', err.message || String(err)));
