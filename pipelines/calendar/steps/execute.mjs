#!/usr/bin/env node
/**
 * calendar / execute.mjs — dispatch calendar actions to tools/lib/calendar.mjs.
 *
 * Most actions use the user access_token (from _constructor).
 * check_freebusy may need tenant token when resolving names — passes cfg through.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { getConfig } = await import(
  'file://' + path.join(TOOLS_DIR, 'auth.mjs').replace(/\\/g, '/')
);
const { ACTIONS, FeishuError } = await import(
  'file://' + path.join(TOOLS_DIR, 'lib', 'calendar.mjs').replace(/\\/g, '/')
);

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (c) => { data += c; });
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
  const accessToken = payload.steps?._constructor?.output?.access_token;

  if (!accessToken) fail('missing_token', '_constructor did not provide access_token');
  if (!input.action) fail('missing_param', 'input.action 必填');
  const handler = ACTIONS[input.action];
  if (!handler) fail('unsupported_action', `unsupported action: ${input.action}. supported: ${Object.keys(ACTIONS).join(', ')}`);

  let cfg;
  try { cfg = getConfig(__dirname); } catch (err) { fail('config_error', err.message); }

  try {
    const result = await handler(input, accessToken, cfg);
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

main().catch((err) => fail('unexpected_error', err.message || String(err)));
