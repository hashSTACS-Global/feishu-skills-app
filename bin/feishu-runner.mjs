#!/usr/bin/env node
/**
 * Pipeline Runner for feishu-skills APP (Agent Pipeline Protocol v0.4).
 *
 * Spec: https://github.com/hashSTACS-Global/agent-pipeline-protocol
 *
 * Constructor/Destructor (v0.4 framework guarantee):
 *   - pipelines/_constructor/ runs BEFORE the business pipeline.
 *     Failure aborts the whole flow.
 *   - pipelines/_destructor/ runs AFTER the business pipeline regardless of
 *     success or failure (like try-finally). Failure does not mask business error.
 *   - Both directories are auto-detected and excluded from routing.
 *
 * Usage:
 *   node bin/feishu-runner.mjs <pipeline> [--key value ...]    # execute a pipeline
 *   node bin/feishu-runner.mjs list                            # list business pipelines
 *   node bin/feishu-runner.mjs resume <session_id> --llm-output '<json>'
 *
 * Code-step contract (per v0.4 spec):
 *   stdin:  {"input": {...}, "steps": {step_name: {"output": {...}}, ...}}
 *   stdout: {"output": {...}}                        # success
 *   exit:   non-zero with stderr/stdout JSON         # failure
 */
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, '..');
const PIPELINES_DIR = join(APP_DIR, 'pipelines');
const SESSIONS_DIR = join(APP_DIR, '.sessions');
const CONSTRUCTOR_NAME = '_constructor';
const DESTRUCTOR_NAME = '_destructor';

// ---------------------------------------------------------------------------
// YAML loading — minimal parser sufficient for our pipeline.yaml shape.
// Same semantics as the prior Python _parse_minimal_yaml; NOT a general parser.
// ---------------------------------------------------------------------------
function loadYaml(path) {
  const content = readFileSync(path, 'utf-8');
  return parseMinimalYaml(content);
}

function parseMinimalYaml(content) {
  const result = { steps: [] };
  let currentStep = null;
  let inPromptBlock = false;
  let promptLines = [];
  let promptIndent = 0;
  let section = null;

  for (const raw of content.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const stripped = line.trim();

    if (inPromptBlock) {
      const prefix = ' '.repeat(promptIndent);
      if (!line.startsWith(prefix) && stripped) {
        if (currentStep) currentStep.prompt = promptLines.join('\n').replace(/\s+$/, '');
        inPromptBlock = false;
        promptLines = [];
      } else {
        promptLines.push(line.length > promptIndent ? line.slice(promptIndent) : '');
        continue;
      }
    }

    if (!stripped || stripped.startsWith('#')) continue;

    if (stripped.startsWith('- name:')) {
      if (currentStep) result.steps.push(currentStep);
      currentStep = { name: unquote(stripped.slice('- name:'.length).trim()) };
      section = 'step';
      continue;
    }

    if (section === 'step' && currentStep && stripped.startsWith('prompt:')) {
      const after = stripped.slice('prompt:'.length).trim();
      if (after.startsWith('|')) {
        inPromptBlock = true;
        promptLines = [];
        promptIndent = line.length - line.trimStart().length + 2;
      } else {
        currentStep.prompt = unquote(after);
      }
      continue;
    }

    if (section === 'step' && currentStep && stripped.includes(':')) {
      const idx = stripped.indexOf(':');
      const key = stripped.slice(0, idx).trim();
      const val = stripped.slice(idx + 1).trim();
      currentStep[key] = val ? unquote(val) : null;
      continue;
    }

    if (stripped.startsWith('triggers:')) {
      section = 'triggers';
      result.triggers = [];
      continue;
    }
    if (section === 'triggers' && stripped.startsWith('- ')) {
      result.triggers.push(unquote(stripped.slice(2).trim()));
      continue;
    }

    if (stripped.startsWith('input:')) {
      section = 'input';
      result.input = {};
      continue;
    }
    if (section === 'input' && stripped.includes(':')) {
      const idx = stripped.indexOf(':');
      const key = stripped.slice(0, idx).trim();
      const val = stripped.slice(idx + 1).trim();
      result.input[key] = unquote(val);
      continue;
    }

    if (stripped.startsWith('steps:')) {
      section = 'steps';
      continue;
    }

    if (stripped.includes(':') && section !== 'step' && section !== 'input') {
      const idx = stripped.indexOf(':');
      const key = stripped.slice(0, idx).trim();
      const val = stripped.slice(idx + 1).trim();
      result[key] = val ? unquote(val) : null;
      section = null;
    }
  }

  if (currentStep) result.steps.push(currentStep);
  return result;
}

function unquote(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Template rendering — {{step.output.field}} and {{input.field}}
// ---------------------------------------------------------------------------
function renderTemplate(template, params, context) {
  return template.replace(/\{\{(.+?)\}\}/g, (_, exprRaw) => {
    const expr = exprRaw.trim();
    const parts = expr.split('.');

    let val;
    if (parts[0] === 'input') {
      val = params;
      for (const p of parts.slice(1)) {
        val = val && typeof val === 'object' ? val[p] ?? '' : '';
      }
    } else if (parts[0] in context) {
      val = context[parts[0]];
      for (const p of parts.slice(1)) {
        val = val && typeof val === 'object' ? val[p] ?? '' : '';
      }
    } else {
      return `{{${exprRaw}}}`;
    }

    if (val && typeof val === 'object') return JSON.stringify(val);
    return String(val ?? '');
  });
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------
class StepError extends Error {
  constructor(message, stepName = '', stdoutJson = null) {
    super(message);
    this.name = 'StepError';
    this.stepName = stepName;
    this.stdoutJson = stdoutJson;
  }
}

class PausedForLLM extends Error {
  constructor({ sessionId, stepName, prompt, schema, modelTier }) {
    super('paused');
    this.name = 'PausedForLLM';
    this.sessionId = sessionId;
    this.stepName = stepName;
    this.prompt = prompt;
    this.schema = schema;
    this.modelTier = modelTier;
  }
}

function runCodeStep(step, pipelineDir, params, context) {
  const stdinPayload = JSON.stringify({
    input: params,
    steps: Object.fromEntries(
      Object.entries(context).map(([k, v]) => [k, { output: (v && v.output) || {} }]),
    ),
  });

  const cmd = step.command;
  const cmdParts = typeof cmd === 'string' ? cmd.split(/\s+/) : [...cmd];
  // Allow `python3` command shim override via env for flexibility, but keep
  // the rest of the command as-is.
  if (cmdParts[0] === 'python3') {
    cmdParts[0] = process.env.PYTHON || 'python3';
  }
  const [program, ...args] = cmdParts;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, {
      cwd: pipelineDir,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        FEISHU_APP_DIR: APP_DIR,
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    child.on('error', (err) => {
      rejectPromise(
        new StepError(
          `failed to spawn code step '${step.name}': ${err.message}`,
          step.name,
        ),
      );
    });

    child.on('close', (code) => {
      if (code !== 0) {
        const body = (stdout.trim() || stderr.trim()).slice(0, 500);
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch {}
        return rejectPromise(
          new StepError(`code step '${step.name}' exited ${code}: ${body}`, step.name, parsed),
        );
      }
      if (!stdout.trim()) {
        return rejectPromise(
          new StepError(`code step '${step.name}' produced empty stdout`, step.name),
        );
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch (e) {
        rejectPromise(
          new StepError(
            `code step '${step.name}' produced invalid JSON: ${e.message}\nstdout[:500]: ${stdout.slice(0, 500)}`,
            step.name,
          ),
        );
      }
    });

    child.stdin.write(stdinPayload);
    child.stdin.end();
  });
}

function runLlmStep(step, pipelineDir, params, context, sessionId) {
  const renderedPrompt = renderTemplate(step.prompt || '', params, context);
  let schemaObj = null;
  if (step.schema) {
    const fullSchemaPath = join(pipelineDir, step.schema);
    if (existsSync(fullSchemaPath)) {
      schemaObj = JSON.parse(readFileSync(fullSchemaPath, 'utf-8'));
    }
  }

  if (process.env.ANTHROPIC_API_KEY) {
    // Full-auto mode stub — keep parity with prior runner.
    throw new StepError(
      "Full-auto mode not yet implemented. Set ANTHROPIC_API_KEY=skip and use collaborative mode (Claude Code resume) for now.",
      step.name,
    );
  }

  throw new PausedForLLM({
    sessionId,
    stepName: step.name,
    prompt: renderedPrompt,
    schema: schemaObj,
    modelTier: step.model || 'standard',
  });
}

// ---------------------------------------------------------------------------
// Pipeline execution with constructor/destructor
// ---------------------------------------------------------------------------
async function executePipeline(pipelineName, params, seedContext = null, sessionId = null) {
  const pipelineDir = join(PIPELINES_DIR, pipelineName);
  const yamlPath = join(pipelineDir, 'pipeline.yaml');
  if (!existsSync(yamlPath)) {
    return { status: 'error', message: `pipeline.yaml not found: ${yamlPath}` };
  }

  const pipelineDef = loadYaml(yamlPath);
  const steps = pipelineDef.steps || [];
  const outputStep = pipelineDef.output || '';
  const context = { ...(seedContext || {}) };
  const sid = sessionId || randomUUID().replace(/-/g, '').slice(0, 12);

  for (const step of steps) {
    try {
      let result;
      if (step.type === 'code') {
        result = await runCodeStep(step, pipelineDir, params, context);
      } else if (step.type === 'llm') {
        result = runLlmStep(step, pipelineDir, params, context, sid);
      } else {
        return { status: 'error', message: `unknown step type: ${step.type}` };
      }
      context[step.name] = result;
    } catch (err) {
      if (err instanceof PausedForLLM) {
        saveSession(sid, pipelineName, params, context, step.name);
        return {
          status: 'paused',
          session: sid,
          llm_request: {
            step: err.stepName,
            prompt: err.prompt,
            schema: err.schema,
            model: err.modelTier,
          },
        };
      }
      if (err instanceof StepError) {
        if (err.stdoutJson && err.stepName) {
          context[err.stepName] = { output: err.stdoutJson };
        }
        return { status: 'error', message: err.message, step_outputs: context };
      }
      throw err;
    }
  }

  let finalOutput = {};
  if (outputStep && outputStep in context) {
    finalOutput = (context[outputStep] && context[outputStep].output) || {};
  } else if (steps.length > 0) {
    const lastName = steps[steps.length - 1].name;
    finalOutput = (context[lastName] && context[lastName].output) || {};
  }

  return { status: 'completed', output: finalOutput, step_outputs: context };
}

async function executeWithLifecycle(pipelineName, params) {
  const constructorDir = join(PIPELINES_DIR, CONSTRUCTOR_NAME);
  const destructorDir = join(PIPELINES_DIR, DESTRUCTOR_NAME);
  const seedContext = {};

  // Read business pipeline definition to check for required_scope.
  // If declared and caller didn't provide scope, inject it so the
  // constructor can proactively verify / upgrade OAuth scopes.
  const bizYamlPath = join(PIPELINES_DIR, pipelineName, 'pipeline.yaml');
  if (existsSync(bizYamlPath)) {
    const bizDef = loadYaml(bizYamlPath);
    if (bizDef.required_scope && !params.scope) {
      params.scope = bizDef.required_scope;
    }
  }

  if (existsSync(join(constructorDir, 'pipeline.yaml'))) {
    const ctorResult = await executePipeline(CONSTRUCTOR_NAME, params);
    if (ctorResult.status === 'error') {
      return {
        status: 'error',
        message: `constructor failed: ${ctorResult.message}`,
        phase: 'constructor',
      };
    }
    if (ctorResult.status === 'paused') return ctorResult;
    seedContext[CONSTRUCTOR_NAME] = { output: ctorResult.output || {} };
  }

  let businessResult = await executePipeline(pipelineName, params, seedContext);

  // Auto-retry on permission_required: re-run constructor with the missing
  // scopes, then retry the business pipeline once.
  if (businessResult.status === 'error') {
    const stepOutputs = businessResult.step_outputs || {};
    // Find the step whose output contains a permission_required error.
    const failedOut = Object.values(stepOutputs)
      .map(s => s?.output || {})
      .find(o => o.error === 'permission_required' && o.required_scopes);
    if (failedOut) {
      const scopes = Array.isArray(failedOut.required_scopes)
        ? failedOut.required_scopes.join(' ')
        : String(failedOut.required_scopes);
      process.stderr.write(`[runner] permission_required → re-auth with scope: ${scopes}\n`);
      params.scope = scopes;
      if (existsSync(join(constructorDir, 'pipeline.yaml'))) {
        const retryCtorResult = await executePipeline(CONSTRUCTOR_NAME, params);
        if (retryCtorResult.status === 'error') {
          return {
            status: 'error',
            message: `constructor (scope retry) failed: ${retryCtorResult.message}`,
            phase: 'constructor',
          };
        }
        if (retryCtorResult.status === 'paused') return retryCtorResult;
        seedContext[CONSTRUCTOR_NAME] = { output: retryCtorResult.output || {} };
      }
      businessResult = await executePipeline(pipelineName, params, seedContext);
    }
  }

  if (existsSync(join(destructorDir, 'pipeline.yaml'))) {
    let destructorResult;
    try {
      destructorResult = await executePipeline(DESTRUCTOR_NAME, params, seedContext);
    } catch (e) {
      destructorResult = { status: 'error', message: `destructor exception: ${e.message}` };
    }
    businessResult.destructor_output = destructorResult;
  }

  return businessResult;
}

// ---------------------------------------------------------------------------
// Sessions (collaborative LLM mode)
// ---------------------------------------------------------------------------
function saveSession(sessionId, pipelineName, params, context, pausedAt) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const payload = { pipeline: pipelineName, params, context, paused_at: pausedAt };
  writeFileSync(
    join(SESSIONS_DIR, `${sessionId}.json`),
    JSON.stringify(payload),
    'utf-8',
  );
}

function loadSession(sessionId) {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function deleteSession(sessionId) {
  const path = join(SESSIONS_DIR, `${sessionId}.json`);
  if (existsSync(path)) unlinkSync(path);
}

async function handleResume(sessionId, llmOutputStr) {
  const session = loadSession(sessionId);
  if (!session) {
    return { status: 'error', message: `session not found: ${sessionId}` };
  }

  let llmOutput;
  try {
    llmOutput = llmOutputStr ? JSON.parse(llmOutputStr) : {};
  } catch (e) {
    return {
      status: 'error',
      message: `invalid llm_output JSON: ${e.message}`,
      retry: true,
    };
  }

  const { pipeline: pipelineName, params, context, paused_at: pausedAt } = session;
  context[pausedAt] = { output: llmOutput };

  const result = await executePipeline(pipelineName, params, context, sessionId);
  if (result.status !== 'paused') deleteSession(sessionId);
  return result;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function listPipelines() {
  if (!existsSync(PIPELINES_DIR)) return [];
  return readdirSync(PIPELINES_DIR)
    .filter((name) => {
      if (name.startsWith('_')) return false;
      const full = join(PIPELINES_DIR, name);
      try {
        if (!statSync(full).isDirectory()) return false;
      } catch {
        return false;
      }
      return existsSync(join(full, 'pipeline.yaml'));
    })
    .sort();
}

function parseKvArgs(argv) {
  let result = {};

  // Pass 1: --input-base64 <b64>
  //   The base64-decoded string must be a JSON object; its fields become
  //   the initial params. Use this when calling shells (PowerShell, cmd)
  //   mangle quotes inside complex JSON values.
  const b64Idx = argv.indexOf('--input-base64');
  if (b64Idx !== -1) {
    if (b64Idx + 1 >= argv.length) {
      throw new Error('--input-base64 requires a value');
    }
    const b64 = argv[b64Idx + 1];
    let decoded;
    try {
      decoded = Buffer.from(b64, 'base64').toString('utf-8');
    } catch (e) {
      throw new Error(`--input-base64 decode failed: ${e.message}`);
    }
    let obj;
    try {
      obj = JSON.parse(decoded);
    } catch (e) {
      throw new Error(
        `--input-base64 is not valid JSON after decode: ${e.message}; got: ${decoded.slice(0, 120)}...`,
      );
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new Error('--input-base64 must decode to a JSON object, not array/primitive');
    }
    result = { ...obj };
  }

  // Pass 2: regular --key value (override base64 fields if both present)
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === '--input-base64') {
      i += 2;
      continue;
    }
    if (token.startsWith('--')) {
      const key = token.slice(2).replace(/-/g, '_');
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        result[key] = coerce(argv[i + 1]);
        i += 2;
      } else {
        result[key] = true;
        i += 1;
      }
    } else {
      i += 1;
    }
  }
  return result;
}

function coerce(raw) {
  const s = raw.trim();
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return raw;
    }
  }
  const lower = s.toLowerCase();
  if (lower === 'true' || lower === 'false') return lower === 'true';
  if (lower === 'null') return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return raw;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.log(
      JSON.stringify({
        status: 'error',
        message: 'Usage: feishu-runner.mjs <pipeline|list|resume> [args...]',
      }),
    );
    process.exit(1);
  }

  const command = args[0];
  const rest = args.slice(1);

  if (command === 'list') {
    const pipelines = listPipelines();
    console.log(
      JSON.stringify({ status: 'completed', output: { pipelines } }),
    );
    return;
  }

  if (command === 'resume') {
    if (rest.length === 0) {
      console.log(
        JSON.stringify({
          status: 'error',
          message: "Usage: feishu-runner.mjs resume <session_id> --llm-output '<json>'",
        }),
      );
      process.exit(1);
    }
    const sessionId = rest[0];
    let llmOutput = '';
    const idx = rest.indexOf('--llm-output');
    if (idx !== -1 && idx + 1 < rest.length) llmOutput = rest[idx + 1];
    const result = await handleResume(sessionId, llmOutput);
    console.log(JSON.stringify(result));
    return;
  }

  const params = parseKvArgs(rest);
  const result = await executeWithLifecycle(command, params);
  console.log(JSON.stringify(result));
}

main().catch((err) => {
  console.log(
    JSON.stringify({ status: 'error', message: err.message || String(err) }),
  );
  process.exit(1);
});
