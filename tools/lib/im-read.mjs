/**
 * tools/lib/im-read.mjs — Feishu IM read operations.
 *
 * Two actions with different auth modes:
 *   get_messages    — uses tenant_access_token (app-level, reads chat history)
 *   search_messages — uses user_access_token   (user-level, searches across user's chats)
 */

class FeishuError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

async function apiCall(method, urlPath, token, body, query) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) {
        if (Array.isArray(v)) v.forEach(item => params.append(k, item));
        else params.set(k, String(v));
      }
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new FeishuError('api_error', `API non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`); }
}

function checkApi(data, opName) {
  if (data.code === 0) return data;
  const msg = `${opName} failed: code=${data.code} msg=${data.msg}`;
  if (data.code === 99991663) throw new FeishuError('auth_required', '飞书 token 已失效，请重新授权');
  if (data.code === 99991400) throw new FeishuError('rate_limited', msg);
  if (data.code === 99991672 || data.code === 99991679 || /permission|scope|not support|tenant/i.test(data.msg || '')) {
    throw new FeishuError('permission_required', msg, {
      required_scopes: ['im:message', 'im:message:readonly', 'im:message.group_msg'],
      auth_type: 'tenant',
      reply: '⚠️ 读取群消息需要应用级权限（需要管理员开通 im:message / im:message.group_msg）',
    });
  }
  throw new FeishuError('api_error', msg);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parseRelativeTime(rel) {
  const now = Date.now();
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const ms = todayStart.getTime();
  const DAY = 86400000;
  switch (rel) {
    case 'today':       return { start: ms, end: now };
    case 'yesterday':   return { start: ms - DAY, end: ms };
    case 'last_3_days': return { start: ms - 3 * DAY, end: now };
    case 'this_week': {
      const d = todayStart.getDay() || 7;
      return { start: ms - (d - 1) * DAY, end: now };
    }
    case 'last_week': {
      const d = todayStart.getDay() || 7;
      const thisWeekStart = ms - (d - 1) * DAY;
      return { start: thisWeekStart - 7 * DAY, end: thisWeekStart };
    }
    case 'last_month':  return { start: ms - 30 * DAY, end: now };
    default:            return { start: ms - 7 * DAY, end: now };
  }
}

function toSeconds(ms) { return String(Math.floor(ms / 1000)); }

function resolveTimeRange(args) {
  if (args.relative_time) {
    const { start, end } = parseRelativeTime(args.relative_time);
    return { start_time: toSeconds(start), end_time: toSeconds(end) };
  }
  if (args.start_time || args.end_time) {
    return {
      start_time: args.start_time ? toSeconds(new Date(args.start_time).getTime()) : undefined,
      end_time: args.end_time ? toSeconds(new Date(args.end_time).getTime()) : undefined,
    };
  }
  return {};
}

async function resolveP2PChatId(openId, token) {
  const data = await apiCall('POST', '/im/v1/chats/p2p', token, {
    id_type: 'open_id', id: openId,
  });
  if (data.code !== 0) {
    const batchData = await apiCall('POST', '/im/v1/chat_p2p/batch_query', token,
      { user_ids: [openId] }, { user_id_type: 'open_id' });
    if (batchData.code === 0 && batchData.data?.items?.length > 0) {
      return batchData.data.items[0].chat_id;
    }
    return null;
  }
  return data.data?.chat_id;
}

function formatMessage(msg) {
  let content = '';
  try {
    const parsed = JSON.parse(msg.body?.content || '{}');
    content = parsed.text || parsed.content || msg.body?.content || '';
  } catch {
    content = msg.body?.content || '';
  }
  return {
    message_id: msg.message_id,
    msg_type: msg.msg_type,
    content,
    sender_id: msg.sender?.id,
    sender_type: msg.sender?.sender_type,
    create_time: msg.create_time,
    thread_id: msg.thread_id,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** get_messages — tenant token */
export async function getMessages(args, tenantToken) {
  let chatId = args.chat_id;
  if (!chatId && args.target_open_id) {
    chatId = await resolveP2PChatId(args.target_open_id, tenantToken);
    if (!chatId) throw new FeishuError('resolve_failed', `无法解析用户 ${args.target_open_id} 的会话 ID`);
  }
  if (!chatId) throw new FeishuError('missing_param', '需要 chat_id 或 target_open_id');

  const timeRange = resolveTimeRange(args);
  const containerType = args.thread_id ? 'thread' : 'chat';
  const containerId = args.thread_id || chatId;

  const query = {
    container_id_type: containerType,
    container_id: containerId,
    sort_type: args.sort_rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
    page_size: String(Math.min(args.page_size || 20, 50)),
  };
  if (timeRange.start_time) query.start_time = timeRange.start_time;
  if (timeRange.end_time)   query.end_time   = timeRange.end_time;
  if (args.page_token)      query.page_token = args.page_token;

  const data = await apiCall('GET', '/im/v1/messages', tenantToken, null, query);
  checkApi(data, 'Get messages');

  const messages = (data.data?.items || []).map(formatMessage);
  return {
    action: 'get_messages',
    messages,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `获取到 ${messages.length} 条消息`,
  };
}

/** search_messages — user token */
export async function searchMessages(args, userToken) {
  if (!args.query) throw new FeishuError('missing_param', 'query 必填');

  const timeRange = resolveTimeRange(args);
  const searchBody = { query: args.query };
  if (timeRange.start_time) searchBody.start_time = timeRange.start_time;
  if (timeRange.end_time)   searchBody.end_time   = timeRange.end_time;
  if (args.sender_ids)  searchBody.from_ids       = (Array.isArray(args.sender_ids)  ? args.sender_ids  : args.sender_ids.split(',')).map(s => s.trim());
  if (args.chat_id)     searchBody.chat_ids       = [args.chat_id];
  if (args.mention_ids) searchBody.at_chatter_ids = (Array.isArray(args.mention_ids) ? args.mention_ids : args.mention_ids.split(',')).map(s => s.trim());
  if (args.message_type) searchBody.message_type = args.message_type;
  if (args.sender_type)  searchBody.from_type    = args.sender_type;
  if (args.chat_type)    searchBody.chat_type    = args.chat_type === 'group' ? 'group_chat' : 'p2p_chat';

  const query = {
    user_id_type: 'open_id',
    page_size: String(Math.min(args.page_size || 20, 50)),
  };
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall('POST', '/search/v2/message', userToken, searchBody, query);
  checkApi(data, 'Search messages');

  const messages = (data.data?.items || []).map(formatMessage);
  return {
    action: 'search_messages',
    messages,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `搜索到 ${messages.length} 条消息`,
  };
}

export { FeishuError };
