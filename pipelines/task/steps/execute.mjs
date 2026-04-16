#!/usr/bin/env node
/**
 * task / execute.mjs — thin adapter that spawns legacy script as subprocess.
 * Token already prepared by _constructor (saved to local store).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { stdinToOutput } = await import(
  'file://' + path.join(TOOLS_DIR, 'legacy-adapter.mjs').replace(/\\/g, '/')
);

await stdinToOutput({
  skillDir: 'feishu-task',
  script: 'task.mjs',
  timeoutMs: 120000,
});
