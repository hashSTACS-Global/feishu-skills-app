# 端到端手动验证步骤

> 本文档让你在自己环境跑一次完整 OAuth + 发消息流程，验证 APP 是否按 v0.4 规范工作：
>
> 1. `_constructor` 在业务 pipeline 之前自动执行
> 2. token 缺失时触发 OAuth 阻塞等待，不被 Runner 杀掉
> 3. token 拿到后业务 pipeline 自动继续，发消息成功
>
> 自动化测试见 [`../integration/`](../integration/) 和 [`../README.md`](../README.md)。

## 准备

### 1. 设置飞书 App 凭证（环境变量）

**Windows PowerShell**：
```powershell
$env:FEISHU_APP_ID = "cli_xxx"           # 填你自己应用的 App ID
$env:FEISHU_APP_SECRET = "xxx"           # 填你自己应用的 App Secret
```

**Git Bash / Linux / Mac**：
```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

> 凭证从 [飞书开放平台](https://open.feishu.cn) → 你的企业自建应用 → "凭证与基础信息" 复制。**不要把 secret 贴进代码或文档里。**

### 2. 找到你自己的飞书 open_id

最简单的方式：在飞书电脑端打开任意聊天，浏览器开发者工具看 API 请求。或者在你已有 token 的环境跑 `search-user` pipeline：
```bash
python bin/feishu-runner.py search-user --open-id <已知任一open_id> --query "你的姓名"
```
返回结果里就有你的 `open_id`（形如 `ou_xxxxxxxx`）。

如果你完全没有现成 token，可以先不填 open_id 直接跑下面场景 A，Runner 会报 `missing_param` 提示你。

### 3. 选择消息接收目标

- **发给自己**：`receive_id` 用你自己的 open_id，`receive_id_type=open_id`
- **发到群**：`receive_id` 用 `oc_xxxxxx` 形式的 chat_id，`receive_id_type=chat_id`

---

## 测试场景

### 场景 A：架构基础验证（不需要凭证）

确认 Runner、`_constructor`、业务 pipeline 联动正确。

```bash
cd feishu-skills-app
python bin/feishu-runner.py list
```
**预期输出**（约 0.5 秒返回，列出 19 个业务 pipeline）：
```json
{"status":"completed","output":{"pipelines":["bitable","calendar","chat","create-doc","doc-comment","doc-media","docx-download","drive","fetch-doc","im-file-analyze","im-message","im-read","image-ocr","search-doc","search-user","sheet","task","update-doc","wiki"]}}
```

```bash
python bin/feishu-runner.py im-message --open-id ou_invalid --action send
```
**预期输出**（约 1 秒返回）：
```json
{"status":"error","phase":"constructor","message":"constructor failed: ... config_error ..."}
```
关键点：`phase: "constructor"` 证明业务 pipeline 没有被执行，框架级保证生效。

> ⚠️ 如果你的环境变量没设置，会停在 `config_error`；设置了的话会继续走到 auth 流程。

---

### 场景 B：完整 OAuth 阻塞 → 发消息（核心 PoC，需要凭证 + open_id）

把 `<YOUR_OPEN_ID>` 替换为你自己的 open_id：

```bash
cd feishu-skills-app
python bin/feishu-runner.py im-message \
  --open-id <YOUR_OPEN_ID> \
  --action send \
  --receive-id <YOUR_OPEN_ID> \
  --receive-id-type open_id \
  --msg-type text \
  --content '{"text":"PoC 测试消息（来自 feishu-skills-app v0.4）"}'
```

**预期行为**：
1. 你的飞书会收到一张「🔐 飞书授权」卡片（最长等 2-3 秒）
2. 命令行**停在那里不动**，这就是 v0.4 `_constructor` 的阻塞等待
3. 你点击卡片完成授权
4. 命令行继续执行，约 1-2 秒后输出：

```json
{"status":"completed","output":{"message_id":"om_xxxxxx","chat_id":"oc_xxxxxx","create_time":"...","reply":"消息已发送（message_id=om_xxxxxx）"}}
```

5. 你的飞书会收到 PoC 测试消息

**这一步成功就证明**：
- ✅ `_constructor` 阻塞 60 秒不被 Runner 杀掉（核心假设 Q1 通过）
- ✅ subprocess 完整传递 stdin/stdout JSON
- ✅ token 在 `_constructor` 拿到后正确注入到业务 pipeline 的 `steps._constructor.output`
- ✅ 业务 pipeline 调 lib 函数成功发消息

---

### 场景 C：第二次跑（验证 token 缓存）

授权完成后立即再跑一次场景 B 的命令。

**预期**：
- 不再发授权卡片
- 命令行**几秒内**直接返回成功（token 已缓存且有效）

证明 `getValidToken()` 的缓存路径生效。

---

### 场景 D：超时验证（可选）

跑场景 B 但**不要点授权卡片**，等 60 秒。

**预期**：
- 60 秒后命令行返回：
```json
{"status":"error","phase":"constructor","message":"... auth_failed ..."}
```

证明超时机制正常，不会无限阻塞。

---

## 出错时怎么看

所有错误都是结构化 JSON，包含：
- `error` / `message`：错误代码 + 描述
- `phase`：在哪个阶段失败（`constructor` / 业务 pipeline）

常见错误：
| `error` | 原因 |
|---|---|
| `config_error` | 没有设置 FEISHU_APP_ID/SECRET 环境变量 |
| `missing_param` | 命令缺少必填参数（按提示补全） |
| `auth_failed` | OAuth 流程超时或用户拒绝 |
| `permission_required` | App 没开 IM 发消息权限（飞书开放平台后台开通） |
| `api_error` | 飞书 API 返回业务错误（看 message 详情） |

## 验证完成后告诉我

- 场景 B 通过 → PoC 验证完成，可进 Phase 2
- 场景 B 卡住 → 把命令行最后输出的 JSON 给我看
- 场景 D 60 秒后没自动失败 → Runner 可能没有 timeout，把卡住的命令贴给我
