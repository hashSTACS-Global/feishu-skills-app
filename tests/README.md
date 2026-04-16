# Tests

## Quick start

### 1. Architecture validation (no credentials needed)

Tests Pipeline Runner mechanics: pipeline discovery, `_constructor` lifecycle, error propagation.

```bash
cd feishu-skills-app
pip install pytest                                        # one-time
python -m pytest tests/integration/test_constructor_lifecycle.py -v
```

### 2. Full smoke test (requires Feishu credentials)

Tests every one of the 19 business pipelines with a safe action (read-only or sandbox write).

**Required env**:
```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
export FEISHU_TEST_OPEN_ID="ou_xxx"          # your own open_id
```

**Optional env** (more tests get skipped if absent):
```bash
export FEISHU_TEST_FOLDER_TOKEN="xxx"        # sandbox folder for create-doc test
export FEISHU_TEST_BITABLE_APP="xxx"         # bitable app_token for table tests
export FEISHU_TEST_BITABLE_TABLE="tblxxx"    # table_id under that app
export FEISHU_TEST_DOC_TOKEN="xxx"           # docx token for fetch-doc test
export FEISHU_TEST_CHAT_ID="ocxxx"           # group chat for im-read get_messages
```

Run:
```bash
python tests/integration/test_all_pipelines.py
```

## Verdict categories

| Verdict | Meaning | Example |
|---|---|---|
| **PASS** | Pipeline returned `status: completed` | drive list returned items |
| **EXPECTED** | Returned a known error code that matches `expected_errors` for this case | scope not granted, missing required param (intentional) |
| **SKIPPED** | Required env var not set (test fixture missing) | no `FEISHU_TEST_DOC_TOKEN` for fetch-doc |
| **FAIL** | Unexpected error code or assertion failed | 🔴 real bug in our code |

Exit code is `0` if there are zero FAILs (PASS + EXPECTED both green). The CI gate uses this.

## Adding a new pipeline test

In `tests/integration/test_all_pipelines.py`, append to the `TESTS` list:

```python
TestCase(
    pipeline="my-new-pipeline",
    description="what this exercises",
    args=["--action", "list"],                    # safe action
    asserts=lambda out: "items" in out,           # for PASS cases
    # OR
    expected_errors=("missing_param",),           # for validation/scope cases
    requires=("FEISHU_TEST_FOO_TOKEN",),          # if needs an env fixture
),
```

## Reference: last verified result

### 2026-04-16, minimal env (only FEISHU_APP_ID/SECRET + FEISHU_TEST_OPEN_ID)
```
=== Summary ===
  PASS:     3   (drive list, search-doc, search-user)
  EXPECTED: 14  (validation errors + scopes user hasn't granted)
  SKIPPED:  4   (bitable × 2, fetch-doc, create-doc — all need optional fixtures)
  FAIL:     0
```

### Earlier run with all optional fixtures set
```
=== Summary ===
  PASS:     6   (drive list, bitable list_tables/records, search-doc, create-doc, search-user)
  EXPECTED: 14  (validation errors + scopes user hasn't granted)
  SKIPPED:  1   (fetch-doc needs test doc token)
  FAIL:     0
```
