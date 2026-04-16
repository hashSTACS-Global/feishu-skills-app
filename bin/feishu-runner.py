#!/usr/bin/env python
"""Pipeline Runner for feishu-skills APP (Agent Pipeline Protocol v0.4).

Spec: https://github.com/hashSTACS-Global/agent-pipeline-protocol

Modes:
  - Full-auto: ANTHROPIC_API_KEY set -> Runner calls LLM API directly
  - Collaborative: no API key -> Runner pauses at LLM steps, returns prompt JSON
    for the caller (Claude Code) to execute, then resume with output

Constructor/Destructor (v0.4 framework guarantee):
  - pipelines/_constructor/ runs BEFORE the business pipeline.
    Failure aborts the whole flow.
  - pipelines/_destructor/ runs AFTER the business pipeline regardless of
    success or failure (like try-finally). Failure does not mask business error.
  - Both directories are auto-detected and excluded from routing.

Usage:
  python runner.py <pipeline> [--key value ...]    # execute a pipeline
  python runner.py list                            # list business pipelines
  python runner.py resume <session_id> --llm-output '<json>'

Code-step contract (per v0.4 spec):
  stdin:  {"input": {...}, "steps": {step_name: {"output": {...}}, ...}}
  stdout: {"output": {...}}                        # success
  exit:   non-zero with stderr/stdout JSON         # failure
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any, Optional

os.environ["PYTHONIOENCODING"] = "utf-8"
# Force stdout/stderr to UTF-8 on Windows (default cp936/GBK breaks on emoji).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

APP_DIR = Path(__file__).resolve().parent.parent  # bin/ → app root
PIPELINES_DIR = APP_DIR / "pipelines"
SESSIONS_DIR = APP_DIR / ".sessions"
CONSTRUCTOR_NAME = "_constructor"
DESTRUCTOR_NAME = "_destructor"

MODEL_TIER_MAPPING = {
    "lite": "claude-haiku-4-5-20251001",
    "standard": "claude-sonnet-4-6",
    "reasoning": "claude-opus-4-6",
}


# ---------------------------------------------------------------------------
# YAML loading (no external deps)
# ---------------------------------------------------------------------------

def load_yaml(path: Path) -> dict:
    """Load a pipeline.yaml file. Prefer PyYAML if available, fall back to
    a minimal in-house parser sufficient for our pipeline.yaml shape."""
    try:
        import yaml
        with open(path, encoding="utf-8") as f:
            return yaml.safe_load(f)
    except ImportError:
        return _parse_minimal_yaml(path)


def _parse_minimal_yaml(path: Path) -> dict:
    """Minimal YAML parser: name/description/triggers/input/steps/output.
    Sufficient for our pipeline.yaml format. NOT a general parser."""
    with open(path, encoding="utf-8") as f:
        content = f.read()

    result: dict[str, Any] = {"steps": []}
    current_step: Optional[dict] = None
    in_prompt_block = False
    prompt_lines: list[str] = []
    prompt_indent = 0

    section: Optional[str] = None  # current top-level key being filled

    for raw_line in content.split("\n"):
        line = raw_line.rstrip()
        stripped = line.strip()

        # Multi-line prompt: collect until dedent
        if in_prompt_block:
            if not line.startswith(" " * prompt_indent) and stripped:
                if current_step is not None:
                    current_step["prompt"] = "\n".join(prompt_lines).rstrip()
                in_prompt_block = False
                prompt_lines = []
            else:
                prompt_lines.append(
                    line[prompt_indent:] if len(line) > prompt_indent else ""
                )
                continue

        if not stripped or stripped.startswith("#"):
            continue

        # Step list entry
        if stripped.startswith("- name:"):
            if current_step is not None:
                result["steps"].append(current_step)
            current_step = {"name": stripped.split(":", 1)[1].strip().strip('"\'')}
            section = "step"
            continue

        if section == "step" and current_step is not None and stripped.startswith("prompt:"):
            after = stripped.split(":", 1)[1].strip()
            if after.startswith("|"):
                in_prompt_block = True
                prompt_lines = []
                prompt_indent = (len(line) - len(line.lstrip())) + 2
            else:
                current_step["prompt"] = after.strip('"\'')
            continue

        if section == "step" and current_step is not None and ":" in stripped:
            key, _, val = stripped.partition(":")
            current_step[key.strip()] = val.strip().strip('"\'') if val.strip() else None
            continue

        # Top-level keys
        if stripped.startswith("triggers:"):
            section = "triggers"
            result["triggers"] = []
            continue
        if section == "triggers" and stripped.startswith("- "):
            result["triggers"].append(stripped[2:].strip().strip('"\''))
            continue

        if stripped.startswith("input:"):
            section = "input"
            result["input"] = {}
            continue
        if section == "input" and ":" in stripped:
            key, _, val = stripped.partition(":")
            result["input"][key.strip()] = val.strip().strip('"\'')
            continue

        if stripped.startswith("steps:"):
            section = "steps"
            continue

        if ":" in stripped and section not in {"step", "input"}:
            key, _, val = stripped.partition(":")
            result[key.strip()] = val.strip().strip('"\'')
            section = None
            continue

    if current_step is not None:
        result["steps"].append(current_step)

    return result


# ---------------------------------------------------------------------------
# Template rendering
# ---------------------------------------------------------------------------

def render_template(template: str, params: dict, context: dict) -> str:
    """Replace {{step.output.field}} and {{input.field}} with values."""
    def replacer(match: re.Match) -> str:
        expr = match.group(1).strip()
        parts = expr.split(".")

        if parts[0] == "input":
            val: Any = params
            for p in parts[1:]:
                val = val.get(p, "") if isinstance(val, dict) else ""
            return json.dumps(val, ensure_ascii=False) if isinstance(val, (dict, list)) else str(val)

        step_name = parts[0]
        if step_name in context:
            val = context[step_name]
            for p in parts[1:]:
                val = val.get(p, "") if isinstance(val, dict) else ""
            return json.dumps(val, ensure_ascii=False) if isinstance(val, (dict, list)) else str(val)

        return match.group(0)

    return re.sub(r"\{\{(.+?)\}\}", replacer, template)


# ---------------------------------------------------------------------------
# Step execution
# ---------------------------------------------------------------------------

def run_code_step(
    step: dict,
    pipeline_dir: Path,
    params: dict,
    context: dict,
) -> dict:
    """Execute a code step. Subprocess gets stdin JSON, returns stdout JSON.

    No timeout is set — auth blocking steps may run for up to 60+ seconds.
    """
    stdin_payload = json.dumps({
        "input": params,
        "steps": {k: {"output": v.get("output", {})} for k, v in context.items()},
    }, ensure_ascii=False)

    cmd = step["command"]
    cmd_parts = cmd.split() if isinstance(cmd, str) else list(cmd)
    if cmd_parts and cmd_parts[0] == "python3":
        cmd_parts[0] = sys.executable

    env = {
        **os.environ,
        "PYTHONIOENCODING": "utf-8",
        "FEISHU_APP_DIR": str(APP_DIR),
    }

    proc = subprocess.run(
        cmd_parts,
        cwd=str(pipeline_dir),
        input=stdin_payload,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
    )

    if proc.returncode != 0:
        msg_body = proc.stdout.strip() or proc.stderr.strip()
        raise StepError(
            f"code step '{step['name']}' exited {proc.returncode}: {msg_body[:500]}",
            step_name=step["name"],
        )

    if not proc.stdout.strip():
        raise StepError(
            f"code step '{step['name']}' produced empty stdout",
            step_name=step["name"],
        )

    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise StepError(
            f"code step '{step['name']}' produced invalid JSON: {e}\nstdout[:500]: {proc.stdout[:500]}",
            step_name=step["name"],
        )


def run_llm_step(
    step: dict,
    pipeline_dir: Path,
    params: dict,
    context: dict,
    session_id: str,
) -> dict:
    """Execute an LLM step.

    Full-auto mode (ANTHROPIC_API_KEY set): call API directly.
    Collaborative mode: serialize session and return paused-status sentinel.
    """
    rendered_prompt = render_template(step.get("prompt") or "", params, context)
    schema_path = step.get("schema")
    schema_obj = None
    if schema_path:
        full_schema_path = pipeline_dir / schema_path
        if full_schema_path.exists():
            with open(full_schema_path, encoding="utf-8") as f:
                schema_obj = json.load(f)

    if os.environ.get("ANTHROPIC_API_KEY"):
        return _call_llm_api(step, rendered_prompt, schema_obj)

    # Collaborative mode: persist session, signal pause
    raise PausedForLLM(
        session_id=session_id,
        step_name=step["name"],
        prompt=rendered_prompt,
        schema=schema_obj,
        model_tier=step.get("model", "standard"),
    )


def _call_llm_api(step: dict, prompt: str, schema: Optional[dict]) -> dict:
    """Direct LLM API call (full-auto mode). Stub for now —
    integrate Anthropic SDK when needed."""
    raise StepError(
        "Full-auto mode not yet implemented. Set ANTHROPIC_API_KEY=skip "
        "and use collaborative mode (Claude Code resume) for now.",
        step_name=step["name"],
    )


# ---------------------------------------------------------------------------
# Pipeline execution with constructor/destructor
# ---------------------------------------------------------------------------

class StepError(Exception):
    def __init__(self, message: str, step_name: str = ""):
        super().__init__(message)
        self.step_name = step_name


class PausedForLLM(Exception):
    def __init__(
        self,
        session_id: str,
        step_name: str,
        prompt: str,
        schema: Optional[dict],
        model_tier: str,
    ):
        self.session_id = session_id
        self.step_name = step_name
        self.prompt = prompt
        self.schema = schema
        self.model_tier = model_tier


def execute_pipeline(
    pipeline_name: str,
    params: dict,
    seed_context: Optional[dict] = None,
    session_id: Optional[str] = None,
) -> dict:
    """Execute a single pipeline (no constructor/destructor injection here).

    Returns:
      {"status": "completed", "output": {...}, "step_outputs": {...}}
      {"status": "error",     "message": "..."}
      {"status": "paused",    "session": "...", "llm_request": {...}}
    """
    pipeline_dir = PIPELINES_DIR / pipeline_name
    yaml_path = pipeline_dir / "pipeline.yaml"
    if not yaml_path.exists():
        return {"status": "error", "message": f"pipeline.yaml not found: {yaml_path}"}

    pipeline_def = load_yaml(yaml_path)
    steps = pipeline_def.get("steps", []) or []
    output_step = pipeline_def.get("output", "")
    context: dict = dict(seed_context or {})
    sid = session_id or uuid.uuid4().hex[:12]

    for step in steps:
        try:
            if step.get("type") == "code":
                result = run_code_step(step, pipeline_dir, params, context)
            elif step.get("type") == "llm":
                result = run_llm_step(step, pipeline_dir, params, context, sid)
            else:
                return {"status": "error", "message": f"unknown step type: {step.get('type')}"}
        except PausedForLLM as p:
            _save_session(sid, pipeline_name, params, context, step["name"])
            return {
                "status": "paused",
                "session": sid,
                "llm_request": {
                    "step": p.step_name,
                    "prompt": p.prompt,
                    "schema": p.schema,
                    "model": p.model_tier,
                },
            }
        except StepError as e:
            return {
                "status": "error",
                "message": str(e),
                "step_outputs": context,
            }

        context[step["name"]] = result

    final_output = {}
    if output_step and output_step in context:
        final_output = context[output_step].get("output", {})
    elif steps:
        # default: last step's output
        last_name = steps[-1]["name"]
        final_output = context.get(last_name, {}).get("output", {})

    return {"status": "completed", "output": final_output, "step_outputs": context}


def execute_with_lifecycle(pipeline_name: str, params: dict) -> dict:
    """Execute a business pipeline wrapped by _constructor / _destructor.

    - _constructor runs first; on failure, abort and return its error.
    - business pipeline runs next; output of _constructor is injected
      into context as steps['_constructor'].
    - _destructor always runs after, regardless of business success/failure.
      Its result is attached as 'destructor_output' but does NOT override
      a business error.
    """
    constructor_dir = PIPELINES_DIR / CONSTRUCTOR_NAME
    destructor_dir = PIPELINES_DIR / DESTRUCTOR_NAME

    seed_context: dict = {}

    # 1. Constructor
    if (constructor_dir / "pipeline.yaml").exists():
        ctor_result = execute_pipeline(CONSTRUCTOR_NAME, params)
        if ctor_result["status"] == "error":
            return {
                "status": "error",
                "message": f"constructor failed: {ctor_result['message']}",
                "phase": "constructor",
            }
        if ctor_result["status"] == "paused":
            # Constructor itself paused for LLM — propagate up
            return ctor_result
        seed_context[CONSTRUCTOR_NAME] = {"output": ctor_result.get("output", {})}

    # 2. Business pipeline
    business_result = execute_pipeline(pipeline_name, params, seed_context=seed_context)

    # 3. Destructor (always)
    destructor_result = None
    if (destructor_dir / "pipeline.yaml").exists():
        try:
            destructor_result = execute_pipeline(DESTRUCTOR_NAME, params, seed_context=seed_context)
        except Exception as e:
            destructor_result = {"status": "error", "message": f"destructor exception: {e}"}

    if destructor_result:
        business_result["destructor_output"] = destructor_result

    return business_result


# ---------------------------------------------------------------------------
# Sessions (collaborative LLM mode)
# ---------------------------------------------------------------------------

def _save_session(
    session_id: str, pipeline_name: str, params: dict, context: dict, paused_at: str
) -> None:
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "pipeline": pipeline_name,
        "params": params,
        "context": context,
        "paused_at": paused_at,
    }
    (SESSIONS_DIR / f"{session_id}.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8"
    )


def _load_session(session_id: str) -> Optional[dict]:
    path = SESSIONS_DIR / f"{session_id}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def _delete_session(session_id: str) -> None:
    path = SESSIONS_DIR / f"{session_id}.json"
    if path.exists():
        path.unlink()


def handle_resume(session_id: str, llm_output_str: str) -> dict:
    """Resume a paused pipeline by injecting the LLM output for the paused step."""
    session = _load_session(session_id)
    if not session:
        return {"status": "error", "message": f"session not found: {session_id}"}

    try:
        llm_output = json.loads(llm_output_str) if llm_output_str else {}
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"invalid llm_output JSON: {e}",
            "retry": True,
        }

    pipeline_name = session["pipeline"]
    params = session["params"]
    context = session["context"]
    paused_at = session["paused_at"]
    context[paused_at] = {"output": llm_output}

    result = execute_pipeline(
        pipeline_name, params, seed_context=context, session_id=session_id
    )
    if result["status"] != "paused":
        _delete_session(session_id)
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def list_pipelines() -> list[str]:
    """List business pipelines (skip _constructor / _destructor)."""
    if not PIPELINES_DIR.exists():
        return []
    out = []
    for child in sorted(PIPELINES_DIR.iterdir()):
        if not child.is_dir():
            continue
        if child.name.startswith("_"):
            continue
        if (child / "pipeline.yaml").exists():
            out.append(child.name)
    return out


def parse_kv_args(argv: list[str]) -> dict:
    """Parse --key value pairs into a dict. Values that look like JSON
    (starting with { [ true false null or digit) are parsed as JSON."""
    result: dict = {}
    i = 0
    while i < len(argv):
        token = argv[i]
        if token.startswith("--"):
            key = token[2:].replace("-", "_")
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                raw = argv[i + 1]
                result[key] = _coerce(raw)
                i += 2
            else:
                result[key] = True
                i += 1
        else:
            i += 1
    return result


def _coerce(raw: str) -> Any:
    s = raw.strip()
    if s.startswith(("{", "[")):
        try:
            return json.loads(s)
        except json.JSONDecodeError:
            return raw
    if s.lower() in {"true", "false"}:
        return s.lower() == "true"
    if s.lower() == "null":
        return None
    if s.lstrip("-").isdigit():
        return int(s)
    return raw


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "status": "error",
            "message": "Usage: runner.py <pipeline|list|resume> [args...]",
        }, ensure_ascii=False))
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    if command == "list":
        pipelines = list_pipelines()
        print(json.dumps({"status": "completed", "output": {"pipelines": pipelines}}, ensure_ascii=False))
        return

    if command == "resume":
        if not args:
            print(json.dumps({"status": "error", "message": "Usage: runner.py resume <session_id> --llm-output '<json>'"}))
            sys.exit(1)
        session_id = args[0]
        llm_output = ""
        if "--llm-output" in args:
            idx = args.index("--llm-output")
            if idx + 1 < len(args):
                llm_output = args[idx + 1]
        result = handle_resume(session_id, llm_output)
        print(json.dumps(result, ensure_ascii=False))
        return

    # Pipeline execution
    pipeline_name = command
    params = parse_kv_args(args)
    result = execute_with_lifecycle(pipeline_name, params)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
