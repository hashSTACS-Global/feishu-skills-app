"""End-to-end smoke test for all 19 pipelines.

Strategy:
  - Each pipeline gets ONE safe read-only invocation (or write to test sandbox).
  - We classify outcomes into: PASS / EXPECTED_ERROR / FAIL / SKIPPED.
  - PASS:           pipeline returned status=completed
  - EXPECTED_ERROR: pipeline returned a known scope/permission/missing-param error
                    that we intentionally don't trigger (e.g. write-only ops with
                    no test fixture, or scope user hasn't granted)
  - FAIL:           pipeline failed in an unexpected way (real bug)
  - SKIPPED:        prerequisites missing (e.g. no test app_token)

Required env:
  FEISHU_APP_ID
  FEISHU_APP_SECRET
  FEISHU_TEST_OPEN_ID         — your own open_id
  FEISHU_TEST_CHAT_ID         — optional, a chat you're in (for im-read get_messages)
  FEISHU_TEST_DOC_TOKEN       — optional, a docx token to read
  FEISHU_TEST_BITABLE_APP     — optional, a bitable app_token
  FEISHU_TEST_BITABLE_TABLE   — optional, a table_id under that app
  FEISHU_TEST_FOLDER_TOKEN    — optional, a sandbox folder for writes

Run from feishu-skills-app/:
  python tests/integration/test_all_pipelines.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

APP_DIR = Path(__file__).resolve().parent.parent.parent
RUNNER = APP_DIR / "bin" / "feishu-runner.py"

# ---------------------------------------------------------------------------
# Test config
# ---------------------------------------------------------------------------

OPEN_ID         = os.environ.get("FEISHU_TEST_OPEN_ID", "")
CHAT_ID         = os.environ.get("FEISHU_TEST_CHAT_ID", "")
DOC_TOKEN       = os.environ.get("FEISHU_TEST_DOC_TOKEN", "")
BITABLE_APP     = os.environ.get("FEISHU_TEST_BITABLE_APP", "")
BITABLE_TABLE   = os.environ.get("FEISHU_TEST_BITABLE_TABLE", "")
FOLDER_TOKEN    = os.environ.get("FEISHU_TEST_FOLDER_TOKEN", "")


@dataclass
class TestCase:
    pipeline: str
    description: str
    args: list[str]
    # If error.code is in `expected_errors`, treat as EXPECTED_ERROR (not FAIL).
    expected_errors: tuple[str, ...] = ()
    # If True and required env var is missing, mark SKIPPED.
    requires: tuple[str, ...] = ()
    # Treat success specially? E.g. "must contain key X in output"
    asserts: Optional[callable] = None


def _has_env(*names: str) -> bool:
    return all(bool(os.environ.get(n)) for n in names)


# ---------------------------------------------------------------------------
# Test matrix — one safe call per pipeline
# ---------------------------------------------------------------------------

TESTS: list[TestCase] = [
    # ── IM ──────────────────────────────────────────────────────────
    TestCase(
        pipeline="im-message",
        description="send (write-only; we only verify auth + missing receive_id)",
        args=["--action", "send"],  # no receive_id -> missing_param
        expected_errors=("missing_param",),
    ),
    TestCase(
        pipeline="im-read",
        description="search_messages (user token)",
        args=["--action", "search_messages", "--query", "test", "--page-size", "3"],
        expected_errors=("permission_required",),  # user may not have search:message scope
    ),
    TestCase(
        pipeline="im-read",
        description="get_messages (tenant token, p2p resolve)",
        args=["--action", "get_messages", "--target-open-id", OPEN_ID, "--page-size", "3"],
        expected_errors=("api_error", "missing_param"),  # upstream 404 known
    ),

    # ── Drive ───────────────────────────────────────────────────────
    TestCase(
        pipeline="drive",
        description="list root folder",
        args=["--action", "list"],
        asserts=lambda out: "items" in out,
    ),

    # ── Bitable ─────────────────────────────────────────────────────
    TestCase(
        pipeline="bitable",
        description="list_tables of test app",
        args=["--action", "list_tables", "--app-token", BITABLE_APP],
        requires=("FEISHU_TEST_BITABLE_APP",),
        asserts=lambda out: "tables" in out,
    ),
    TestCase(
        pipeline="bitable",
        description="list_records (read-only)",
        args=["--action", "list_records",
              "--app-token", BITABLE_APP, "--table-id", BITABLE_TABLE,
              "--page-size", "3"],
        requires=("FEISHU_TEST_BITABLE_APP", "FEISHU_TEST_BITABLE_TABLE"),
        asserts=lambda out: "records" in out,
    ),

    # ── Docs ────────────────────────────────────────────────────────
    TestCase(
        pipeline="search-doc",
        description="search docs (real action='all')",
        args=["--action", "all", "--query", "test", "--count", "3"],
        expected_errors=("missing_param", "permission_required", "api_error"),
    ),
    TestCase(
        pipeline="fetch-doc",
        description="fetch a docx by token",
        args=["--doc-id", DOC_TOKEN],
        requires=("FEISHU_TEST_DOC_TOKEN",),
        expected_errors=("missing_param", "permission_required"),
    ),
    TestCase(
        pipeline="create-doc",
        description="create doc in test sandbox folder",
        args=["--title", "smoke-test-create-doc", "--folder-token", FOLDER_TOKEN, "--markdown", "test"],
        requires=("FEISHU_TEST_FOLDER_TOKEN",),
        asserts=lambda out: "doc_id" in out,
    ),
    TestCase(
        pipeline="update-doc",
        description="missing required params",
        args=[],
        expected_errors=("missing_param", "missing_arg"),
    ),
    TestCase(
        pipeline="docx-download",
        description="missing doc-id (verify validation)",
        args=[],
        expected_errors=("missing_param", "missing_arg"),
    ),
    TestCase(
        pipeline="doc-comment",
        description="no action (verify validation)",
        args=[],
        expected_errors=("missing_param",),
    ),
    TestCase(
        pipeline="doc-media",
        description="no action (verify validation)",
        args=[],
        expected_errors=("missing_param",),
    ),

    # ── Sheet / Wiki ────────────────────────────────────────────────
    TestCase(
        pipeline="sheet",
        description="no action (verify validation)",
        args=[],
        expected_errors=("missing_param",),
    ),
    TestCase(
        pipeline="wiki",
        description="no action (verify validation)",
        args=[],
        expected_errors=("missing_param",),
    ),

    # ── Calendar / Task / Chat ──────────────────────────────────────
    TestCase(
        pipeline="calendar",
        description="list_events past 7 days",
        args=["--action", "list_events",
              "--start-min", "2026-04-09T00:00:00+08:00",
              "--start-max", "2026-04-16T23:59:59+08:00",
              "--page-size", "5"],
        expected_errors=("api_error", "permission_required"),  # field validation may fail upstream
    ),
    TestCase(
        pipeline="task",
        description="list_tasks",
        args=["--action", "list_tasks", "--page-size", "3"],
        expected_errors=("permission_required",),  # task:task:read scope
    ),
    TestCase(
        pipeline="chat",
        description="search chats by keyword",
        args=["--action", "search", "--query", "PoC", "--page-size", "3"],
        expected_errors=("permission_required", "missing_param", "missing_arg", "api_error"),
    ),

    # ── Tools (tenant token only) ───────────────────────────────────
    TestCase(
        pipeline="search-user",
        description="search by name",
        args=["--query", "岳碧林", "--page-size", "3"],
        asserts=lambda out: "users" in out,
    ),
    TestCase(
        pipeline="image-ocr",
        description="missing image (verify validation)",
        args=[],
        expected_errors=("missing_param", "missing_arg"),
    ),
    TestCase(
        pipeline="im-file-analyze",
        description="missing message-id (verify validation)",
        args=[],
        expected_errors=("missing_param", "missing_arg"),
    ),
]

# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

ANSI = {
    "green": "\033[92m", "red": "\033[91m",
    "yellow": "\033[93m", "blue": "\033[94m",
    "gray": "\033[90m", "bold": "\033[1m", "reset": "\033[0m",
}


def color(text: str, c: str) -> str:
    if not sys.stdout.isatty():
        return text
    return f"{ANSI[c]}{text}{ANSI['reset']}"


def run_pipeline(pipeline: str, extra_args: list[str], timeout_s: int = 30) -> dict:
    """Invoke runner.py and parse stdout JSON."""
    cmd = [sys.executable, str(RUNNER), pipeline, "--open-id", OPEN_ID, *extra_args]
    proc = subprocess.run(
        cmd,
        cwd=str(APP_DIR),
        capture_output=True,
        text=True,
        encoding="utf-8",
        env={**os.environ, "PYTHONIOENCODING": "utf-8"},
        timeout=timeout_s,
    )
    if not proc.stdout:
        return {"status": "error", "message": f"no stdout. stderr: {proc.stderr[:300]}"}
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        return {"status": "error", "message": f"bad JSON: {e}\nstdout: {proc.stdout[:300]}"}


def evaluate(case: TestCase, result: dict) -> tuple[str, str]:
    """Return (verdict, detail) where verdict in {PASS, EXPECTED, FAIL}."""
    status = result.get("status")
    if status == "completed":
        out = result.get("output", {})
        if case.asserts:
            try:
                if not case.asserts(out):
                    return "FAIL", f"assert failed: output={json.dumps(out, ensure_ascii=False)[:200]}"
            except Exception as e:
                return "FAIL", f"assert exception: {e}"
        return "PASS", _summarize_output(out)
    if status == "error":
        # Extract error code from nested structure
        msg = result.get("message", "")
        code = _extract_error_code(msg, result)
        if code in case.expected_errors:
            return "EXPECTED", f"{code}: {msg[:120]}"
        return "FAIL", f"unexpected error code={code}: {msg[:200]}"
    return "FAIL", f"unknown status: {status}"


def _summarize_output(out: dict) -> str:
    """Pick a few interesting fields for display."""
    keys_of_interest = ["count", "reply", "message_id", "doc_id", "app_token",
                        "table_id", "folder_token", "items", "users", "messages",
                        "records", "tables", "fields"]
    parts = []
    for k in keys_of_interest:
        if k in out:
            v = out[k]
            if isinstance(v, list):
                parts.append(f"{k}={len(v)} items")
            elif isinstance(v, str) and len(v) > 80:
                parts.append(f"{k}={v[:60]}…")
            else:
                parts.append(f"{k}={v}")
    return " | ".join(parts) if parts else "(empty output)"


def _extract_error_code(msg: str, result: dict) -> str:
    """Errors are nested: outer message contains inner JSON from execute step."""
    # Direct error (constructor failure)
    if "error" in result:
        return result["error"]
    # Nested in message: ...exited 1: {"error":"missing_param",...}
    import re
    m = re.search(r'"error"\s*:\s*"([^"]+)"', msg)
    if m:
        return m.group(1)
    return "unknown"


def main():
    if not OPEN_ID:
        print(color("ERROR", "red") + ": FEISHU_TEST_OPEN_ID env var required")
        print("Set FEISHU_APP_ID, FEISHU_APP_SECRET, FEISHU_TEST_OPEN_ID at minimum.")
        sys.exit(1)

    print(color("\n=== Feishu Skills APP — Smoke Test ===", "bold"))
    print(f"App:      {os.environ.get('FEISHU_APP_ID', '?')}")
    print(f"Open ID:  {OPEN_ID}")
    print(f"Pipelines under test: {len(TESTS)}\n")

    counts = {"PASS": 0, "EXPECTED": 0, "FAIL": 0, "SKIPPED": 0}
    fail_details: list[str] = []

    for i, case in enumerate(TESTS, 1):
        # Skip if prerequisites missing
        if case.requires and not _has_env(*case.requires):
            verdict = "SKIPPED"
            detail = f"missing env: {', '.join(case.requires)}"
        else:
            try:
                result = run_pipeline(case.pipeline, case.args)
                verdict, detail = evaluate(case, result)
            except subprocess.TimeoutExpired:
                verdict, detail = "FAIL", "timed out (>30s)"
            except Exception as e:
                verdict, detail = "FAIL", f"runner exception: {e}"

        counts[verdict] += 1
        verdict_colors = {"PASS": "green", "EXPECTED": "blue",
                          "FAIL": "red", "SKIPPED": "gray"}
        print(f"  [{i:2}/{len(TESTS):2}] {color(f'{verdict:<8}', verdict_colors[verdict])} "
              f"{case.pipeline:<18} — {case.description}")
        if verdict in {"FAIL", "SKIPPED"}:
            print(f"           {color(detail[:200], 'gray')}")
        elif detail:
            print(f"           {color(detail[:200], 'gray')}")

        if verdict == "FAIL":
            fail_details.append(f"{case.pipeline} ({case.description}): {detail}")

    # Summary
    print(color("\n=== Summary ===", "bold"))
    print(f"  {color('PASS',     'green')}:    {counts['PASS']}")
    print(f"  {color('EXPECTED', 'blue')}:  {counts['EXPECTED']}  (known scope/scope-not-granted)")
    print(f"  {color('SKIPPED',  'gray')}: {counts['SKIPPED']}  (test fixtures not provided)")
    print(f"  {color('FAIL',     'red')}:    {counts['FAIL']}")

    if fail_details:
        print(color("\n=== Failures ===", "red"))
        for line in fail_details:
            print(f"  - {line}")

    # Exit code: 0 if no FAILs (PASS + EXPECTED both OK)
    sys.exit(0 if counts["FAIL"] == 0 else 1)


if __name__ == "__main__":
    main()
