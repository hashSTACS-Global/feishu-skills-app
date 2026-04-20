/**
 * tools/lib/_common.mjs — Shared primitives for all feishu-skills lib modules.
 *
 * Contract (per Agent Pipeline Protocol v0.4):
 *   "Pipelines are declarations, not implementations."
 *   Libraries here are thin API adapters + explicit validators.
 *   NO silent fixing, NO auto-fetching, NO parameter coercion.
 *   Fail fast with structured FeishuError so the LLM can decide what to do.
 *
 * Exports:
 *   FeishuError   — throwable error { code, message, ...extra }
 *   apiCall       — async(method, urlPath, token, { body, query, raw }) → json | Response
 *   checkApi      — (data, opName, { domain }) → data (throws FeishuError on non-zero code)
 *   requireParam  — (args, key, hint?) → throws missing_param if unset
 *   requireOneOf  — (args, keys, hint?) → throws missing_param if none set
 */

const API_BASE = 'https://open.feishu.cn/open-apis';

export class FeishuError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'FeishuError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function isRawBody(b) {
  if (b == null) return false;
  if (typeof b === 'string') return true;
  if (typeof FormData !== 'undefined' && b instanceof FormData) return true;
  if (typeof Blob !== 'undefined' && b instanceof Blob) return true;
  if (b instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(b)) return true;
  return false;
}

/**
 * Make a Feishu Open API call.
 *
 * @param {string} method   HTTP method
 * @param {string} urlPath  Path starting with "/" (gets prefixed with API_BASE), or full URL
 * @param {string} token    Bearer token (user_access_token or tenant_access_token)
 * @param {object} [opts]
 * @param {object|FormData|string|Buffer} [opts.body]
 *          Plain object → JSON.stringify'd with Content-Type: application/json.
 *          FormData → passed as-is (fetch sets multipart Content-Type).
 *          string / Blob / ArrayBuffer / TypedArray → passed as-is, no Content-Type set.
 * @param {object} [opts.query]  Query params; values stringified, null/undefined dropped
 * @param {object} [opts.headers]  Extra request headers (override defaults)
 * @param {boolean} [opts.raw=false]  Return raw Response instead of parsed JSON
 * @returns {Promise<object|Response>}
 */
export async function apiCall(method, urlPath, token, { body, query, headers, raw = false } = {}) {
  let url = urlPath.startsWith('http') ? urlPath : `${API_BASE}${urlPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const finalHeaders = { Authorization: `Bearer ${token}` };
  let fetchBody;
  if (body !== undefined && body !== null) {
    if (isRawBody(body)) {
      fetchBody = body;
    } else {
      finalHeaders['Content-Type'] = 'application/json; charset=utf-8';
      fetchBody = JSON.stringify(body);
    }
  }
  if (headers) Object.assign(finalHeaders, headers);

  const res = await fetch(url, { method, headers: finalHeaders, body: fetchBody });
  if (raw) return res;

  let data;
  try {
    data = await res.json();
  } catch {
    throw new FeishuError(
      'api_error',
      `Feishu API returned non-JSON: HTTP ${res.status} ${res.statusText}`,
      { http_status: res.status },
    );
  }
  return data;
}

// ---------------------------------------------------------------------------
// Domain-specific error message patterns.
// Each entry: if `test(rawMsg)` matches, throw FeishuError(code, message, {reply}).
// Order matters — first match wins within a domain.
// ---------------------------------------------------------------------------
const DOMAIN_ERROR_PATTERNS = {
  bitable: [
    {
      test: (msg) => /primary\s+field.*cannot\s+be\s+deleted/i.test(msg) || /主字段.*不能.*删除/.test(msg),
      code: 'cannot_modify_primary_field',
      message: '主字段不能删除或重命名（飞书多维表格主字段受系统保护）',
      reply: '这是飞书硬规则。若想换主字段，请在表里新建字段后把数据迁过去',
    },
    {
      test: (msg) => /last\s+table\s+cannot\s+be\s+deleted/i.test(msg) || /最后.*表.*不能.*删除/.test(msg),
      code: 'cannot_delete_last_table',
      message: '最后一张数据表不能删除（每个多维表格至少保留一张表）',
      reply: '先创建一张新表，再删除这张',
    },
  ],
};

// Domain → default required_scopes payload attached to permission_required errors.
// Used by the Runner's auto-retry mechanism (see bin/feishu-runner.mjs:404-431).
const DOMAIN_PERMISSION_SCOPES = {
  bitable: ['bitable:app', 'drive:drive'],
  drive: ['drive:drive', 'drive:drive:readonly'],
  'im-message': ['im:message', 'im:message:send_as_bot'],
  'im-read': ['im:message:readonly', 'im:chat:readonly'],
  calendar: ['calendar:calendar'],
  chat: ['im:chat:readonly', 'im:chat.members:read'],
  'create-doc': ['docx:document', 'docx:document:create', 'docs:doc', 'drive:drive'],
  'doc-comment': ['drive:drive', 'drive:drive.readonly'],
  'doc-media': ['drive:drive', 'docx:document'],
  'docx-download': ['docx:document:readonly', 'drive:drive'],
  'fetch-doc': ['docx:document:readonly', 'docs:doc', 'drive:drive'],
  'im-file-analyze': ['im:resource:readonly'],
  'image-ocr': [],
  'search-doc': ['drive:drive', 'wiki:wiki:readonly'],
  'search-user': ['contact:user.base:readonly'],
  sheet: ['sheets:spreadsheet', 'drive:drive'],
  task: ['task:task:read', 'task:task:write'],
  'update-doc': ['docx:document', 'docx:document:write_only', 'docs:doc', 'drive:drive'],
  wiki: ['wiki:wiki', 'wiki:wiki:readonly'],
};

/**
 * Validate a Feishu Open API response envelope.
 * If `data.code === 0`, returns data. Otherwise throws FeishuError.
 *
 * @param {object} data     Response body from apiCall()
 * @param {string} opName   Human-readable operation label, e.g. "Create table"
 * @param {object} [ctx]
 * @param {string} [ctx.domain]  Lib domain key (e.g. "bitable"). Used for
 *                               domain-specific msg matching + required_scopes.
 * @returns {object} the same `data` on success
 * @throws {FeishuError}
 */
export function checkApi(data, opName, { domain } = {}) {
  if (data.code === 0) return data;

  const rawMsg = data.msg || '';
  const generalMsg = `${opName} failed: code=${data.code} msg=${rawMsg}`;

  // ---- Auth / rate limit (all domains share these) ----
  if (data.code === 99991663) {
    throw new FeishuError(
      'auth_required',
      '飞书 token 已失效，请重新授权',
      { reply: '请重新点击飞书中的授权卡片', feishu_code: data.code, feishu_msg: rawMsg },
    );
  }
  if (data.code === 99991400) {
    throw new FeishuError(
      'rate_limited',
      generalMsg,
      { reply: '飞书 API 限流，请稍后重试', feishu_code: data.code, feishu_msg: rawMsg },
    );
  }

  // ---- Domain-specific msg pattern matching (before generic permission check) ----
  const patterns = DOMAIN_ERROR_PATTERNS[domain] || [];
  for (const p of patterns) {
    if (p.test(rawMsg)) {
      throw new FeishuError(p.code, p.message, {
        reply: p.reply,
        feishu_code: data.code,
        feishu_msg: rawMsg,
      });
    }
  }

  // ---- Bitable: 99992402 field validation failed ----
  if (domain === 'bitable' && data.code === 99992402) {
    throw new FeishuError(
      'field_validation_failed',
      '飞书字段校验失败。常见原因：(1) update_field 必须同时传 field_type（可先 list_fields 查询）；(2) single_select/multi_select 的 options[].color 必须是整数 0-54，不能是字符串如 "red"；(3) field_name 为空或重复',
      {
        reply: '检查 field_type 是否提供、color 是否为整数 0-54、field_name 是否有效',
        feishu_code: data.code,
        feishu_msg: rawMsg,
      },
    );
  }

  // ---- Permission: explicit code or message-based catch-all ----
  if (
    data.code === 99991672 ||
    data.code === 99991679 ||
    /permission|scope|not support|tenant/i.test(rawMsg)
  ) {
    const required_scopes = DOMAIN_PERMISSION_SCOPES[domain] || [];
    throw new FeishuError('permission_required', generalMsg, {
      required_scopes,
      reply: '⚠️ 权限不足，需要重新授权',
      feishu_code: data.code,
      feishu_msg: rawMsg,
    });
  }

  // ---- Fallback: generic api_error ----
  throw new FeishuError('api_error', generalMsg, {
    feishu_code: data.code,
    feishu_msg: rawMsg,
  });
}

// ---------------------------------------------------------------------------
// Input validators — throw FeishuError('missing_param' | 'invalid_param').
// ---------------------------------------------------------------------------

/** Throws `missing_param` if `args[key]` is undefined / null / empty string. */
export function requireParam(args, key, hint) {
  const v = args?.[key];
  if (v === undefined || v === null || v === '') {
    const msg = hint ? `${key} 必填（${hint}）` : `${key} 必填`;
    throw new FeishuError('missing_param', msg, { param: key });
  }
}

/** Throws `missing_param` if none of `keys` are set on `args`. */
export function requireOneOf(args, keys, hint) {
  const hasAny = keys.some((k) => {
    const v = args?.[k];
    return v !== undefined && v !== null && v !== '';
  });
  if (!hasAny) {
    const msg = hint
      ? `需要至少提供以下之一：${keys.join(', ')}（${hint}）`
      : `需要至少提供以下之一：${keys.join(', ')}`;
    throw new FeishuError('missing_param', msg, { params: keys });
  }
}
