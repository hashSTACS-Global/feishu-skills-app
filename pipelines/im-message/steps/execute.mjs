#!/usr/bin/env node
/**
 * im-message / execute.mjs
 *
 * stdin:  {
 *   input: {
 *     open_id, action ('send' | 'reply'),
 *     receive_id?, receive_id_type?, msg_type?, content?, image_path?,
 *     message_id?, reply_in_thread?, uuid?
 *   },
 *   steps: { _constructor: { output: { access_token, open_id, ... } } }
 * }
 * stdout: { output: { message_id, chat_id, create_time, reply } }
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { getConfig } = await import(
  'file://' + path.join(TOOLS_DIR, 'auth.mjs').replace(/\\/g, '/')
);
const { sendMessage, replyMessage, FeishuError } = await import(
  'file://' + path.join(TOOLS_DIR, 'lib', 'im-message.mjs').replace(/\\/g, '/')
);

const ACTIONS = { send: sendMessage, reply: replyMessage };

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function emit(obj) { process.stdout.write(JSON.stringify(obj)); }
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
  const ctorOutput = (payload.steps?._constructor?.output) || {};
  const accessToken = ctorOutput.access_token;

  if (!accessToken) {
    fail('missing_token', '_constructor did not provide an access_token');
  }
  if (!input.action) {
    fail('missing_param', 'input.action 必填（send / reply）');
  }
  const handler = ACTIONS[input.action];
  if (!handler) {
    fail('unsupported_action', `unsupported action: ${input.action}`);
  }

  let cfg;
  try {
    cfg = getConfig(__dirname);
  } catch (err) {
    fail('config_error', err.message);
  }

  try {
    const result = await handler(input, accessToken, cfg);
    emit({ output: result });
  } catch (err) {
    if (err instanceof FeishuError) {
      const extra = { ...err };
      delete extra.code;
      delete extra.message;
      fail(err.code, err.message, extra);
    }
    fail('unexpected_error', err.message || String(err));
  }
}

main().catch(err => fail('unexpected_error', err.message || String(err)));
