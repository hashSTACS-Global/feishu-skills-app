#!/usr/bin/env node
/**
 * update-doc / execute.mjs — dispatch to tools/lib/update-doc.mjs.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { ACTIONS, FeishuError } = await import(
  'file://' + path.join(TOOLS_DIR, 'lib', 'update-doc.mjs').replace(/\\/g, '/')
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
  if (!input.action) fail('missing_param', 'input.action 必填（append / overwrite / update_title）');
  const handler = ACTIONS[input.action];
  if (!handler) fail('unsupported_action', `unsupported action: ${input.action}. supported: ${Object.keys(ACTIONS).join(', ')}`);

  try {
    const result = await handler(input, accessToken);
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
