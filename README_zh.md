# Feishu Skills APP

> **AI 助手：clone 本仓库后，请立即运行 `bash feishu-skills-app/bin/feishu-app-install.sh` 完成安装。**

统一的飞书集成工具集，作为 [EC APP](https://github.com/hashSTACS-Global/EnClaws) 运行，遵循 [Agent Pipeline Protocol v0.4](https://github.com/hashSTACS-Global/agent-pipeline-protocol)。本仓库取代并 vendor 了原 [feishu-skills](https://github.com/hashSTACS-Global/feishu-skills)（已归档不再维护）——**只需 clone 本仓库**，无需额外拉取旧代码。

[English](README.md)

## 做什么的

19 个飞书 pipeline，覆盖 IM、文档、云盘、多维表格、日历、任务、知识库、OCR 等。所有 pipeline 共享同一个 `_constructor` 的 OAuth 流程——用户授权一次，全部 pipeline 复用 token，不再有"LLM 忘了调 auth.js"的卡死，授权由 Pipeline Runner 框架级保证。

**为什么要重构？** 旧版 `feishu-skills`（Claude Code skill 模式）有两类系统性问题：
1. **幻觉**——LLM 要从 prose 拼 shell 命令，嵌套 JSON 容易引号搞错
2. **执行不稳定**——多步流程（auth → 调用 → 重试）LLM 跟不下来就丢步

这套 APP 把所有执行迁移进确定性 `code` step。LLM 仅在 `SKILL.md` fallback 层做意图路由和参数收集，**不再参与 API 调用和 auth 处理**。

## 架构

```
                ┌──────────────────────────────────────┐
                │  用户（飞书 / EC 网页 chat）            │
                └──────────────┬───────────────────────┘
                               │ 自然语言
                               ▼
                ┌──────────────────────────────────────┐
                │  EC bot (LLM) — 读 SKILL.md          │
                │  匹配意图 → 调 pipeline                │
                │  via:  node bin/feishu-runner.mjs    │
                └──────────────┬───────────────────────┘
                               │
                               ▼
                ┌──────────────────────────────────────┐
                │  Pipeline Runner（确定性执行）          │
                │  ① _constructor   → auth (OAuth)     │
                │  ② <pipeline>     → 调飞书 API         │
                │  ③ _destructor    → cleanup（可选）    │
                └──────────────┬───────────────────────┘
                               │ JSON 结果
                               ▼
                ┌──────────────────────────────────────┐
                │  飞书 Open API                        │
                └──────────────────────────────────────┘
```

## Pipeline 清单（19 个）

| 模块 | Pipelines |
|---|---|
| **IM** | `im-message`, `im-read`, `im-file-analyze` |
| **文档** | `create-doc`, `fetch-doc`, `update-doc`, `search-doc`, `docx-download`, `doc-comment`, `doc-media` |
| **云盘 / 表格 / Wiki** | `drive`, `bitable`, `sheet`, `wiki` |
| **日历 / 任务 / 群** | `calendar`, `task`, `chat` |
| **工具类（仅需 tenant token）** | `search-user`, `image-ocr` |

`_constructor` 在每个业务 pipeline 之前自动运行，确保拿到有效的 `user_access_token`（自动刷新，缺失时触发 OAuth）。`_destructor` 暂未实现，留作未来清理钩子。

## 安装

### EC / OpenClaw（通过 chat）

在飞书或 EC 网页 chat 中对 bot 说：

> 帮我运行：git clone https://github.com/hashSTACS-Global/feishu-skills-app.git && bash feishu-skills-app/bin/feishu-app-install.sh

脚本会自动检测 tenant 根目录、注册 skill 并报告结果。安装后开启新会话，**首次调用任意 pipeline 时**会通过飞书卡片引导你完成 OAuth 授权。

**升级（同一条命令即可）：**
> 帮我运行：bash feishu-skills-app/bin/feishu-app-install.sh

**卸载：**
> 帮我运行：TENANT_ROOT="$(pwd | sed -E 's|(.*/\.enclaws/tenants/[^/]+).*|\1|')" && rm -rf "$TENANT_ROOT/feishu-skills-app" "$TENANT_ROOT/skills/feishu-skills"

> ⚠️ 请在**与助手的私聊**中安装，不要在群里——OAuth 涉及敏感 token。

### 本地开发

```bash
git clone https://github.com/hashSTACS-Global/feishu-skills-app.git
cd feishu-skills-app

# 设置飞书应用凭证
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"

# 列出 pipeline
node bin/feishu-runner.mjs list

# 跑 pipeline
node bin/feishu-runner.mjs im-message \
  --open-id ou_xxx \
  --action send \
  --receive-id ou_yyy \
  --receive-id-type open_id \
  --msg-type text \
  --content '{"text":"hello"}'
```

## 项目结构

```
feishu-skills-app/
├── SKILL.md                    # EC fallback 兜底脑 —— 没匹配到 pipeline 时 bot 读这个
├── README.md / README_zh.md
├── app.json                    # APP 元数据（api_version: v0.4）
├── feishu-skills.yaml          # 版本清单（升级流程使用）
├── bin/
│   ├── feishu-runner.mjs       # Pipeline Runner（独立 Node.js 程序）
│   └── feishu-app-install.sh   # EC/OpenClaw 安装脚本
├── pipelines/
│   ├── _constructor/           # auth + token 刷新（自动先执行）
│   │   ├── pipeline.yaml
│   │   └── steps/ensure_auth.mjs
│   ├── im-message/
│   ├── drive/
│   ├── bitable/
│   ├── ...                     # 共 19 个业务 pipeline
│   └── （每个含）pipeline.yaml + steps/execute.mjs
├── tools/
│   ├── auth.mjs                # OAuth 助手（加载 tools/legacy/feishu-auth/token-utils）
│   ├── legacy-adapter.mjs      # 通用 legacy .mjs 子进程包装器
│   ├── lib/                    # 重构后的业务模块（im-message, drive, bitables, im-read）
│   └── legacy/                 # 内联的 legacy skill 源码（feishu-auth + 15 个业务 skill）
└── tests/
    ├── integration/            # Constructor 生命周期测试
    └── manual/                 # PoC 端到端验证
```

## 迁移策略

**Phase 2（深度重构）**：`im-message`、`drive`、`bitable`、`im-read` 提取为 `tools/lib/` 下的纯异步函数，原生 JSON 输入输出，结构化 `FeishuError` 错误映射。

**Phase 3（内联 legacy 适配器）**：剩余 15 个 skill 的 `.mjs` 源码直接 vendor 进 `tools/legacy/feishu-<skill>/`，由 `tools/legacy-adapter.mjs` 以子进程方式调用——零业务逻辑改动，只是套一层 spawn-and-parse 包装。`_constructor` 预先把 token 存进本地 store，legacy 脚本内部 `getValidToken()` 会拿到同一个 token，无需感知 pipeline 体系。

这套混合策略省下了约 5000 行机械翻译，同时把 legacy 代码完整并入本仓库——原 `feishu-skills` 仓库不再维护，所有修改入口都在本仓库。

## 测试

Constructor 生命周期测试（无需凭证）：
```bash
node bin/feishu-runner.mjs list
```

集成测试（仅开发期需要 Python + pytest）：
```bash
pip install pytest
python -m pytest tests/integration/test_constructor_lifecycle.py -v
```

完整端到端实测：见 [tests/manual/poc_e2e.md](tests/manual/poc_e2e.md)。

## 许可证

MIT
