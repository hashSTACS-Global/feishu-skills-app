/**
 * tools/lib/im-read.mjs — Feishu IM read operations (thin API adapter).
 *
 * 2 actions with different auth modes:
 *   get_messages    — tenant_access_token (app-level, reads chat history)
 *   search_messages — user_access_token   (user-level, full-text search over user's chats)
 *
 * Contract:
 *   - No silent fallback. If the p2p chat-id resolution fails, throw.
 *   - No silent coercion of comma-string to array; caller must pass arrays.
 *   - relative_time is a legitimate input normalization (translates a small
 *     set of well-defined tokens into unix seconds), not a smart-fixer.
 */

import { FeishuError, apiCall, checkApi, requireParam, requireOneOf } from './_common.mjs';

const DOMAIN = { domain: 'im-read' };

const RELATIVE_TIME_TOKENS = ['today', 'yesterday', 'last_3_days', 'this_week', 'last_week', 'last_month'];
const VALID_SORT_RULES = ['create_time_asc', 'create_time_desc'];
const VALID_CHAT_TYPES = ['p2p_chat', 'group_chat'];

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

function parseRelativeTime(rel) {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const ms = todayStart.getTime();
  const DAY = 86400000;
  switch (rel) {
    case 'today':       return { start: ms,             end: now };
    case 'yesterday':   return { start: ms - DAY,       end: ms };
    case 'last_3_days': return { start: ms - 3 * DAY,   end: now };
    case 'this_week': {
      const d = todayStart.getDay() || 7;
      return { start: ms - (d - 1) * DAY, end: now };
    }
    case 'last_week': {
      const d = todayStart.getDay() || 7;
      const thisWeekStart = ms - (d - 1) * DAY;
      return { start: thisWeekStart - 7 * DAY, end: thisWeekStart };
    }
    case 'last_month':  return { start: ms - 30 * DAY,  end: now };
    default: {
      throw new FeishuError(
        'invalid_param',
        `relative_time 未识别: ${rel}。支持：${RELATIVE_TIME_TOKENS.join(', ')}`,
        { param: 'relative_time', got: rel },
      );
    }
  }
}

function toSeconds(ms) { return String(Math.floor(ms / 1000)); }

function resolveTimeRange(args) {
  if (args.relative_time) {
    const { start, end } = parseRelativeTime(args.relative_time);
    return { start_time: toSeconds(start), end_time: toSeconds(end) };
  }
  if (args.start_time !== undefined || args.end_time !== undefined) {
    const parseOne = (label, v) => {
      if (v === undefined || v === null || v === '') return undefined;
      const t = new Date(v).getTime();
      if (Number.isNaN(t)) {
        throw new FeishuError('invalid_param', `${label} 无法解析为时间: ${v}`, { param: label, got: v });
      }
      return toSeconds(t);
    };
    return {
      start_time: parseOne('start_time', args.start_time),
      end_time: parseOne('end_time', args.end_time),
    };
  }
  return {};
}

async function resolveP2PChatIdByUserToken(openId, token) {
  const data = await apiCall('POST', '/im/v1/chats/p2p', token, {
    body: { id_type: 'open_id', id: openId },
  });
  checkApi(data, 'Resolve p2p chat_id', DOMAIN);
  const chatId = data.data?.chat_id;
  if (!chatId) {
    throw new FeishuError(
      'resolve_failed',
      `无法解析用户 ${openId} 的 p2p 会话 ID（飞书返回 code=0 但未提供 chat_id）`,
      { param: 'target_open_id', got: openId },
    );
  }
  return chatId;
}

function requireArrayParam(args, key) {
  if (!Array.isArray(args[key])) {
    throw new FeishuError('invalid_param', `${key} 必须是字符串数组`, { param: key, got: typeof args[key] });
  }
  return args[key];
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

function requirePageSize(args, max = 50) {
  if (args.page_size === undefined || args.page_size === null) return null;
  if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > max) {
    throw new FeishuError(
      'invalid_param',
      `page_size 必须是 1-${max} 的整数`,
      { param: 'page_size', max },
    );
  }
  return args.page_size;
}

// ---------------------------------------------------------------------------
// Action: get_messages (tenant token)
// ---------------------------------------------------------------------------

export async function getMessages(args, tenantToken) {
  requireOneOf(args, ['chat_id', 'target_open_id'], '要么给 chat_id，要么给 target_open_id 由 pipeline 去 p2p 接口解析');

  let chatId = args.chat_id;
  if (!chatId) {
    chatId = await resolveP2PChatIdByUserToken(args.target_open_id, tenantToken);
  }

  if (args.sort_rule !== undefined && !VALID_SORT_RULES.includes(args.sort_rule)) {
    throw new FeishuError(
      'invalid_param',
      `sort_rule 必须是 ${VALID_SORT_RULES.join(' / ')} 之一`,
      { param: 'sort_rule', got: args.sort_rule },
    );
  }

  const pageSize = requirePageSize(args, 50);
  const timeRange = resolveTimeRange(args);
  const containerType = args.thread_id ? 'thread' : 'chat';
  const containerId = args.thread_id || chatId;

  const query = {
    container_id_type: containerType,
    container_id: containerId,
    sort_type: args.sort_rule === 'create_time_asc' ? 'ByCreateTimeAsc' : 'ByCreateTimeDesc',
  };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (timeRange.start_time) query.start_time = timeRange.start_time;
  if (timeRange.end_time)   query.end_time   = timeRange.end_time;
  if (args.page_token)      query.page_token = args.page_token;

  const data = await apiCall('GET', '/im/v1/messages', tenantToken, { query });
  checkApi(data, 'Get messages', DOMAIN);

  const messages = (data.data?.items || []).map(formatMessage);
  return {
    action: 'get_messages',
    chat_id: chatId,
    messages,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `获取到 ${messages.length} 条消息`,
  };
}

// ---------------------------------------------------------------------------
// Action: search_messages (user token)
// ---------------------------------------------------------------------------

export async function searchMessages(args, userToken) {
  requireParam(args, 'query', '全文搜索关键字');

  if (args.chat_type !== undefined && !VALID_CHAT_TYPES.includes(args.chat_type)) {
    throw new FeishuError(
      'invalid_param',
      `chat_type 必须是 ${VALID_CHAT_TYPES.join(' / ')} 之一`,
      { param: 'chat_type', got: args.chat_type },
    );
  }

  const pageSize = requirePageSize(args, 50);
  const timeRange = resolveTimeRange(args);

  const searchBody = { query: args.query };
  if (timeRange.start_time) searchBody.start_time = timeRange.start_time;
  if (timeRange.end_time)   searchBody.end_time   = timeRange.end_time;
  if (args.sender_ids !== undefined)  searchBody.from_ids       = requireArrayParam(args, 'sender_ids');
  if (args.chat_id)                   searchBody.chat_ids       = [args.chat_id];
  if (args.mention_ids !== undefined) searchBody.at_chatter_ids = requireArrayParam(args, 'mention_ids');
  if (args.message_type)              searchBody.message_type   = args.message_type;
  if (args.sender_type)                searchBody.from_type     = args.sender_type;
  if (args.chat_type)                  searchBody.chat_type     = args.chat_type;

  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall('POST', '/search/v2/message', userToken, { body: searchBody, query });
  checkApi(data, 'Search messages', DOMAIN);

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
