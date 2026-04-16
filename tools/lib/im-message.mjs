/**
 * tools/lib/im-message.mjs — IM message send/reply (pure async functions).
 * Refactored from legacy feishu-im-message/message.mjs (now removed; history in git).
 * No CLI parsing, no process.exit, no stdout writes.
 *
 * Each function accepts a structured args object + accessToken, and either:
 *   - returns the success object on completion
 *   - throws an Error with `.code` property for known error categories
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ALLOWED_IMAGE_DIRS = [
  '/tmp/',
  path.join(os.homedir(), '.enclaws', 'media'),
  path.join(os.homedir(), '.enclaws', 'tenants'),
];

class FeishuError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function apiCall(method, urlPath, accessToken, { body, query } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const entries = Object.entries(query).filter(([, v]) => v != null);
    if (entries.length > 0) url += '?' + new URLSearchParams(Object.fromEntries(entries)).toString();
  }
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new FeishuError('api_error', `API 返回非 JSON (HTTP ${res.status})`);
  }
  return res.json();
}

async function getTenantAccessToken(appId, appSecret) {
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new FeishuError('api_error', `获取 tenant_access_token 失败: code=${data.code} msg=${data.msg}`);
  }
  return data.tenant_access_token;
}

function checkImagePathAllowed(imagePath) {
  const resolved = path.resolve(imagePath);
  const allowed = ALLOWED_IMAGE_DIRS.some(dir => resolved.startsWith(path.resolve(dir)));
  if (!allowed) {
    throw new FeishuError('path_not_allowed',
      `图片路径不在允许范围内: ${imagePath}\n允许的目录: ${ALLOWED_IMAGE_DIRS.join(', ')}`);
  }
}

async function uploadImage(imagePath, appId, appSecret) {
  checkImagePathAllowed(imagePath);
  if (!fs.existsSync(imagePath)) {
    throw new FeishuError('file_not_found', `图片文件不存在: ${imagePath}`);
  }
  const tenantToken = await getTenantAccessToken(appId, appSecret);
  const fileBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);
  const formData = new FormData();
  formData.append('image_type', 'message');
  formData.append('image', new Blob([fileBuffer]), fileName);
  const res = await fetch('https://open.feishu.cn/open-apis/im/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tenantToken}` },
    body: formData,
  });
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new FeishuError('api_error', `上传图片返回非 JSON (HTTP ${res.status})`);
  }
  const data = await res.json();
  if (data.code !== 0) {
    throw new FeishuError('api_error', `上传图片失败: code=${data.code} msg=${data.msg}`);
  }
  return data.data.image_key;
}

/**
 * Normalize the `content` field. In CLI mode it was a JSON string;
 * in pipeline mode the input may be a string OR an object.
 */
function normalizeContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  return JSON.stringify(content);
}

/**
 * Send a message to a chat or user.
 *
 * Args (object):
 *   open_id              — sender's open_id (used for image upload tenant lookup)
 *   receive_id           — target id
 *   receive_id_type      — 'open_id' | 'chat_id'
 *   msg_type             — 'text' | 'post' | 'image' | 'file' | 'interactive' | ...
 *   content              — string (JSON) or object (will be stringified)
 *   image_path?          — local image path; if set, msg_type/content overridden
 *   uuid?                — idempotency key
 *
 * Returns: { message_id, chat_id, create_time, reply }
 * Throws:  FeishuError with code in { missing_param, path_not_allowed, file_not_found, api_error, auth_required, permission_required }
 */
export async function sendMessage(args, accessToken, cfg) {
  let { msg_type: msgType, content, receive_id: receiveId, receive_id_type: receiveIdType, uuid, image_path: imagePath } = args;

  if (imagePath) {
    const imageKey = await uploadImage(imagePath, cfg.appId, cfg.appSecret);
    msgType = 'image';
    content = JSON.stringify({ image_key: imageKey });
  }

  if (!receiveIdType) throw new FeishuError('missing_param', 'receive_id_type 必填（open_id / chat_id）');
  if (!receiveId)     throw new FeishuError('missing_param', 'receive_id 必填');
  if (!msgType)       throw new FeishuError('missing_param', 'msg_type 必填');
  if (!content)       throw new FeishuError('missing_param', 'content 必填');

  const body = {
    receive_id: receiveId,
    msg_type: msgType,
    content: normalizeContent(content),
  };
  if (uuid) body.uuid = uuid;

  let data;
  try {
    data = await apiCall('POST', '/im/v1/messages', accessToken, {
      query: { receive_id_type: receiveIdType },
      body,
    });
  } catch (err) {
    if (err instanceof FeishuError) throw err;
    throw new FeishuError('api_error', err.message || String(err));
  }
  if (data.code !== 0) {
    mapApiError(data, ['im:message']);
  }

  const msg = data.data;
  return {
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `消息已发送（message_id=${msg?.message_id}）`,
  };
}

/**
 * Reply to a specific message.
 *
 * Args:
 *   message_id           — om_xxx
 *   msg_type, content    — same as send
 *   reply_in_thread?     — boolean
 */
export async function replyMessage(args, accessToken) {
  const { message_id: messageId, msg_type: msgType, content, reply_in_thread: replyInThread, uuid } = args;

  if (!messageId) throw new FeishuError('missing_param', 'message_id 必填（om_xxx）');
  if (!msgType)   throw new FeishuError('missing_param', 'msg_type 必填');
  if (!content)   throw new FeishuError('missing_param', 'content 必填');

  const body = {
    content: normalizeContent(content),
    msg_type: msgType,
  };
  if (replyInThread != null) body.reply_in_thread = !!replyInThread;
  if (uuid) body.uuid = uuid;

  let data;
  try {
    data = await apiCall('POST', `/im/v1/messages/${messageId}/reply`, accessToken, { body });
  } catch (err) {
    if (err instanceof FeishuError) throw err;
    throw new FeishuError('api_error', err.message || String(err));
  }
  if (data.code !== 0) {
    mapApiError(data, ['im:message']);
  }

  const msg = data.data;
  return {
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `回复已发送（message_id=${msg?.message_id}）`,
  };
}

function mapApiError(data, requiredScopes) {
  const code = data.code;
  const msg = data.msg || '';
  if (code === 99991663) {
    throw new FeishuError('auth_required', '飞书 token 已失效，请重新授权');
  }
  if (code === 99991672 || code === 99991679 || /permission|scope/i.test(msg)) {
    throw new FeishuError('permission_required', `code=${code} msg=${msg}`, {
      required_scopes: requiredScopes,
      reply: '**权限不足，需要重新授权以获取发送消息权限。**',
    });
  }
  throw new FeishuError('api_error', `code=${code} msg=${msg}`);
}

export { FeishuError };
