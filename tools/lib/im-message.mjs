/**
 * tools/lib/im-message.mjs — IM message send/reply (thin API adapter).
 *
 * 2 actions: send / reply.
 *
 * Contract:
 *   - No auto content coercion. `content` MUST be a JSON string (飞书 API 要求).
 *   - No silent msg_type override. If `image_path` is provided, caller MUST
 *     also set `msg_type: "image"` explicitly; `content` MUST be empty
 *     (the pipeline generates it from the uploaded image_key).
 *   - Missing / wrong params → missing_param / invalid_param.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';
import { getTenantAccessToken } from '../auth.mjs';

const DOMAIN = { domain: 'im-message' };

const ALLOWED_IMAGE_DIRS = [
  '/tmp/',
  path.join(os.homedir(), '.enclaws', 'media'),
  path.join(os.homedir(), '.enclaws', 'tenants'),
];

const VALID_RECEIVE_ID_TYPES = ['open_id', 'user_id', 'union_id', 'email', 'chat_id'];

function checkImagePathAllowed(imagePath) {
  const resolved = path.resolve(imagePath);
  const allowed = ALLOWED_IMAGE_DIRS.some((dir) => resolved.startsWith(path.resolve(dir)));
  if (!allowed) {
    throw new FeishuError(
      'path_not_allowed',
      `图片路径不在允许范围内: ${imagePath}\n允许的目录: ${ALLOWED_IMAGE_DIRS.join(', ')}`,
      { param: 'image_path', allowed_dirs: ALLOWED_IMAGE_DIRS },
    );
  }
}

async function uploadImage(imagePath, appId, appSecret) {
  checkImagePathAllowed(imagePath);
  if (!fs.existsSync(imagePath)) {
    throw new FeishuError('file_not_found', `图片文件不存在: ${imagePath}`, { param: 'image_path' });
  }
  const tenantToken = await getTenantAccessToken(appId, appSecret);
  const fileBuffer = fs.readFileSync(imagePath);
  const fileName = path.basename(imagePath);
  const form = new FormData();
  form.append('image_type', 'message');
  form.append('image', new Blob([fileBuffer]), fileName);
  const data = await apiCall('POST', '/im/v1/images', tenantToken, { body: form });
  checkApi(data, 'Upload image', DOMAIN);
  return data.data.image_key;
}

/** Validate content: must be string (飞书 API 要求). No silent stringify. */
function requireJsonStringContent(args) {
  if (args.content === undefined || args.content === null || args.content === '') {
    throw new FeishuError('missing_param', 'content 必填（JSON 字符串形式）', { param: 'content' });
  }
  if (typeof args.content !== 'string') {
    throw new FeishuError(
      'invalid_param',
      `content 必须是 JSON 字符串，不是 ${typeof args.content}。飞书 API 要求 body.content 是字符串形式，例如 '{"text":"hi"}'。若你有对象，请自行 JSON.stringify 后再传`,
      { param: 'content', got: typeof args.content },
    );
  }
}

// ---------------------------------------------------------------------------
// Action: send
// ---------------------------------------------------------------------------

/**
 * Send a message to a user or chat.
 *
 * Args:
 *   receive_id_type   — one of open_id / user_id / union_id / email / chat_id
 *   receive_id        — target id
 *   msg_type          — text / post / image / file / interactive / ...
 *   content           — JSON string (e.g. '{"text":"hi"}')
 *   image_path?       — local path; when set, msg_type MUST be "image" and
 *                       content MUST be empty (pipeline builds content from image_key)
 *   uuid?             — idempotency key
 *
 * @returns {Promise<object>} { message_id, chat_id, create_time, reply }
 */
export async function sendMessage(args, accessToken, cfg) {
  requireParam(args, 'receive_id_type', `枚举: ${VALID_RECEIVE_ID_TYPES.join(' / ')}`);
  if (!VALID_RECEIVE_ID_TYPES.includes(args.receive_id_type)) {
    throw new FeishuError(
      'invalid_param',
      `receive_id_type 必须是 ${VALID_RECEIVE_ID_TYPES.join(' / ')} 之一`,
      { param: 'receive_id_type', got: args.receive_id_type },
    );
  }
  requireParam(args, 'receive_id');
  requireParam(args, 'msg_type', '如 text / post / image / interactive');

  let content = args.content;

  if (args.image_path !== undefined && args.image_path !== null && args.image_path !== '') {
    if (args.msg_type !== 'image') {
      throw new FeishuError(
        'invalid_param',
        `传了 image_path 就必须 msg_type="image"（当前 msg_type="${args.msg_type}"）`,
        { params: ['image_path', 'msg_type'] },
      );
    }
    if (content !== undefined && content !== null && content !== '') {
      throw new FeishuError(
        'invalid_param',
        '传了 image_path 就不要同时传 content，content 会从上传后的 image_key 自动构造',
        { params: ['image_path', 'content'] },
      );
    }
    if (!cfg?.appId || !cfg?.appSecret) {
      throw new FeishuError('missing_param', 'image_path 上传需要 cfg.appId + cfg.appSecret', { param: 'cfg' });
    }
    const imageKey = await uploadImage(args.image_path, cfg.appId, cfg.appSecret);
    content = JSON.stringify({ image_key: imageKey });
  } else {
    requireJsonStringContent(args);
  }

  const body = {
    receive_id: args.receive_id,
    msg_type: args.msg_type,
    content,
  };
  if (args.uuid) body.uuid = args.uuid;

  const data = await apiCall('POST', '/im/v1/messages', accessToken, {
    query: { receive_id_type: args.receive_id_type },
    body,
  });
  checkApi(data, 'Send message', DOMAIN);

  const msg = data.data;
  return {
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `消息已发送（message_id=${msg?.message_id}）`,
  };
}

// ---------------------------------------------------------------------------
// Action: reply
// ---------------------------------------------------------------------------

/**
 * Reply to a specific message.
 *
 * Args:
 *   message_id        — om_xxx
 *   msg_type          — text / post / image / ...
 *   content           — JSON string
 *   reply_in_thread?  — boolean
 *   uuid?             — idempotency key
 */
export async function replyMessage(args, accessToken) {
  requireParam(args, 'message_id', 'om_ 开头的消息 ID');
  requireParam(args, 'msg_type');
  requireJsonStringContent(args);

  const body = {
    content: args.content,
    msg_type: args.msg_type,
  };
  if (args.reply_in_thread !== undefined) body.reply_in_thread = !!args.reply_in_thread;
  if (args.uuid) body.uuid = args.uuid;

  const data = await apiCall(
    'POST',
    `/im/v1/messages/${encodeURIComponent(args.message_id)}/reply`,
    accessToken,
    { body },
  );
  checkApi(data, 'Reply message', DOMAIN);

  const msg = data.data;
  return {
    message_id: msg?.message_id,
    chat_id: msg?.chat_id,
    create_time: msg?.create_time,
    reply: `回复已发送（message_id=${msg?.message_id}）`,
  };
}

export { FeishuError };
