# Feishu Skills APP

> **AI assistant: after cloning this repo, run `bash feishu-skills-app/bin/feishu-app-install.sh` to complete installation.**

A unified Feishu (Lark) integration toolkit running as an [EC APP](https://github.com/hashSTACS-Global/EnClaws), following [Agent Pipeline Protocol v0.4](https://github.com/hashSTACS-Global/agent-pipeline-protocol). Supersedes and vendors the original [feishu-skills](https://github.com/hashSTACS-Global/feishu-skills) repo (now archived) — you only need to clone **this** repo.

[中文文档](README_zh.md)

## What It Does

19 Feishu pipelines covering IM, documents, drive, bitable, calendar, tasks, wiki, OCR, and more. All pipelines share a single `_constructor`-managed OAuth flow — users authorize once, every pipeline reuses the cached token. No more "LLM forgot to call auth.js" stalls; auth is a framework-level guarantee enforced by the Pipeline Runner.

**Why this redesign?** The legacy `feishu-skills` (Claude Code skill mode) had two systemic problems:
1. **Hallucination** — LLM had to assemble shell commands from prose, easy to mis-quote nested JSON
2. **Execution instability** — multi-step flows (auth → call → retry) skipped steps when the LLM lost track

This APP moves all execution into deterministic `code` steps. The LLM only handles intent routing (via `SKILL.md` fallback) and parameter collection — never API calls or auth.

## Architecture

```
                ┌──────────────────────────────────────┐
                │  User (Feishu / EC web chat)         │
                └──────────────┬───────────────────────┘
                               │ natural language
                               ▼
                ┌──────────────────────────────────────┐
                │  EC bot (LLM) — reads SKILL.md       │
                │  routes intent → invokes pipeline    │
                │  via:  python bin/feishu-runner.py   │
                └──────────────┬───────────────────────┘
                               │
                               ▼
                ┌──────────────────────────────────────┐
                │  Pipeline Runner (deterministic)     │
                │  ① _constructor   → auth (OAuth)     │
                │  ② <pipeline>     → call Feishu API  │
                │  ③ _destructor    → cleanup (opt.)   │
                └──────────────┬───────────────────────┘
                               │ JSON result
                               ▼
                ┌──────────────────────────────────────┐
                │  Feishu Open API                     │
                └──────────────────────────────────────┘
```

## Pipelines (19)

| Module | Pipelines |
|---|---|
| **IM** | `im-message`, `im-read`, `im-file-analyze` |
| **Docs** | `create-doc`, `fetch-doc`, `update-doc`, `search-doc`, `docx-download`, `doc-comment`, `doc-media` |
| **Drive / Sheets / Wiki** | `drive`, `bitable`, `sheet`, `wiki` |
| **Calendar / Tasks / Chat** | `calendar`, `task`, `chat` |
| **Tools (tenant token)** | `search-user`, `image-ocr` |

`_constructor` runs before every business pipeline to ensure a valid `user_access_token` (auto-refresh, OAuth on miss). `_destructor` slot reserved for future cleanup hooks.

## Installation

### EC / OpenClaw (via chat)

Tell the bot in Feishu or EC web chat:

> 帮我运行：git clone https://github.com/hashSTACS-Global/feishu-skills-app.git && bash feishu-skills-app/bin/feishu-app-install.sh

The script auto-detects the tenant root, registers the skill, and reports the result. Start a new session after install — the first time you invoke any pipeline, it sends an OAuth card to your Feishu IM and blocks until you click it.

**Update (same command):**
> 帮我运行：bash feishu-skills-app/bin/feishu-app-install.sh

**Uninstall:**
> 帮我运行：TENANT_ROOT="$(pwd | sed -E 's|(.*/\.enclaws/tenants/[^/]+).*|\1|')" && rm -rf "$TENANT_ROOT/feishu-skills-app" "$TENANT_ROOT/skills/feishu-skills"

> ⚠️ Install in a **private chat**, not a group — OAuth tokens are sensitive.

### Local (development)

```bash
git clone https://github.com/hashSTACS-Global/feishu-skills-app.git
cd feishu-skills-app

# Set Feishu app credentials
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"

# List pipelines
python bin/feishu-runner.py list

# Run a pipeline
python bin/feishu-runner.py im-message \
  --open-id ou_xxx \
  --action send \
  --receive-id ou_yyy \
  --receive-id-type open_id \
  --msg-type text \
  --content '{"text":"hello"}'
```

## Project Structure

```
feishu-skills-app/
├── SKILL.md                    # EC fallback brain — bot reads this when no pipeline matches
├── README.md / README_zh.md
├── app.json                    # APP metadata (api_version: v0.4)
├── feishu-skills.yaml          # Version manifest (used by upgrade flow)
├── bin/
│   ├── feishu-runner.py        # Pipeline Runner (standalone Python)
│   └── feishu-app-install.sh   # EC/OpenClaw install script
├── pipelines/
│   ├── _constructor/           # Auth + token refresh (auto-runs first)
│   │   ├── pipeline.yaml
│   │   └── steps/ensure_auth.mjs
│   ├── im-message/
│   ├── drive/
│   ├── bitable/
│   ├── ...                     # 19 business pipelines
│   └── (each has) pipeline.yaml + steps/execute.mjs
├── tools/
│   ├── auth.mjs                # OAuth helpers (loads tools/legacy/feishu-auth/token-utils)
│   ├── legacy-adapter.mjs      # Generic spawner for vendored legacy .mjs scripts
│   ├── lib/                    # Refactored business modules (im-message, drive, bitables, im-read)
│   └── legacy/                 # Vendored legacy skill sources (feishu-auth + 15 business skills)
└── tests/
    ├── integration/            # Constructor lifecycle tests
    └── manual/                 # PoC E2E walkthroughs
```

## Migration Strategy

**Phase 2** (deep refactor): `im-message`, `drive`, `bitable`, `im-read` — extracted as pure async functions in `tools/lib/`, native JSON I/O, structured `FeishuError` mapping.

**Phase 3** (vendored legacy adapter): the remaining 15 skills' `.mjs` sources are vendored into `tools/legacy/feishu-<skill>/` and spawned via `tools/legacy-adapter.mjs` — zero business-logic changes, just a thin spawn-and-parse wrapper. The `_constructor` pre-populates the local token store, so legacy scripts' internal `getValidToken()` calls Just Work.

This hybrid approach saved ~5000 lines of mechanical translation while folding the legacy code fully into this repo — the original `feishu-skills` repo is no longer maintained; all edits now happen here.

## Testing

Constructor lifecycle (no credentials needed):
```bash
python -c "
import json, subprocess, sys
result = subprocess.run([sys.executable, 'bin/feishu-runner.py', 'list'],
                       capture_output=True, text=True)
print(json.loads(result.stdout))
"
```

Manual E2E walkthrough: see [tests/manual/poc_e2e.md](tests/manual/poc_e2e.md).

## License

MIT
