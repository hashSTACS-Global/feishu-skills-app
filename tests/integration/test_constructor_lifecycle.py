"""Integration tests verifying constructor/destructor lifecycle.

These tests don't require real Feishu credentials — they verify the
Pipeline Runner's core architectural guarantees:
  1. _constructor runs before the business pipeline
  2. _constructor failure aborts the business pipeline
  3. Error is reported with phase="constructor"
  4. Code step stdin/stdout JSON contract works
  5. Subprocess has no premature timeout (auth blocking is feasible)

Run from feishu-skills-app/:
  python -m pytest tests/integration/test_constructor_lifecycle.py -v
"""
import json
import os
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent.parent.parent
RUNNER = APP_DIR / "runner.py"


def run_pipeline(pipeline: str, *args: str) -> dict:
    """Invoke runner.py and parse stdout JSON."""
    cmd = [sys.executable, str(RUNNER), pipeline, *args]
    proc = subprocess.run(
        cmd,
        cwd=str(APP_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
    )
    assert proc.stdout, f"runner produced no stdout. stderr: {proc.stderr}"
    return json.loads(proc.stdout)


def test_runner_discovers_pipelines():
    """Runner.list should find im-message but exclude _constructor."""
    result = run_pipeline("list")
    assert result["status"] == "completed"
    pipelines = result["output"]["pipelines"]
    assert "im-message" in pipelines
    assert "_constructor" not in pipelines  # excluded by underscore convention
    assert "_destructor" not in pipelines


def test_constructor_runs_before_business_and_aborts_on_failure():
    """When _constructor fails, business pipeline must not execute and
    error must indicate phase='constructor'."""
    # No FEISHU_APP_ID env vars → constructor will fail with config_error
    result = run_pipeline(
        "im-message",
        "--open-id", "ou_test_fake",
        "--action", "send",
    )
    assert result["status"] == "error"
    assert result["phase"] == "constructor"
    assert "config_error" in result["message"]
    # Crucially: business step output must NOT appear
    assert "execute" not in result.get("step_outputs", {})


def test_business_pipeline_skipped_on_missing_open_id():
    """Constructor itself reports missing_param when no open_id provided."""
    result = run_pipeline("im-message", "--action", "send")
    assert result["status"] == "error"
    assert result["phase"] == "constructor"
    assert "missing_param" in result["message"] or "open_id" in result["message"]
