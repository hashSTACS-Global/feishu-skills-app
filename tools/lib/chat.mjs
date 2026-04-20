/**
 * tools/lib/chat.mjs — Feishu Chat (3 actions: search / get / list_members).
 *
 * Contract:
 *   - exclude_bots is an explicit caller-controlled boolean; default false.
 *     Old code silently filtered bots from list_members — removed.
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'chat' };

const CHAT_SECURITY_HEADER = { 'X-Chat-Custom-Header': 'enable_chat_list_security_check' };
const VALID_USER_ID_TYPES = ['open_id', 'user_id', 'union_id'];

function checkUserIdType(args) {
  if (args.user_id_type === undefined) return 'open_id';
  if (!VALID_USER_ID_TYPES.includes(args.user_id_type)) {
    throw new FeishuError(
      'invalid_param',
      `user_id_type 必须是 ${VALID_USER_ID_TYPES.join(' / ')} 之一`,
      { param: 'user_id_type', got: args.user_id_type },
    );
  }
  return args.user_id_type;
}

function requirePageSize(args, max = 100) {
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

function isBotMember(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.is_bot === true || m.is_bot === 'true') return true;
  const idType = String(m.member_id_type || m.member_type || m.type || '').toLowerCase();
  if (idType.includes('bot') || idType === 'app_id' || idType === 'open_app_id') return true;
  if (m.sender_type === 'app' || m.member_type === 'app') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function search(args, token) {
  requireParam(args, 'query', '搜索关键字');
  const pageSize = requirePageSize(args);
  const userIdType = checkUserIdType(args);

  const query = { query: args.query.trim(), user_id_type: userIdType };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall('GET', '/im/v1/chats/search', token, { query });
  checkApi(data, 'Chat search', DOMAIN);

  const items = data.data?.items || [];
  return {
    action: 'search',
    items,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `找到 ${items.length} 个相关群组。`,
  };
}

export async function get(args, token) {
  requireParam(args, 'chat_id');
  const userIdType = checkUserIdType(args);

  const data = await apiCall('GET', `/im/v1/chats/${encodeURIComponent(args.chat_id)}`, token, {
    query: { user_id_type: userIdType },
    headers: CHAT_SECURITY_HEADER,
  });
  checkApi(data, 'Get chat', DOMAIN);

  const chat = data.data || {};
  return {
    action: 'get',
    chat,
    reply: chat.name ? `群组：${chat.name}` : '已获取群组详情。',
  };
}

export async function listMembers(args, token) {
  requireParam(args, 'chat_id');
  const userIdType = checkUserIdType(args);
  const pageSize = requirePageSize(args);
  const excludeBots = args.exclude_bots === true;

  const query = { member_id_type: userIdType };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall(
    'GET',
    `/im/v1/chats/${encodeURIComponent(args.chat_id)}/members`,
    token,
    { query, headers: CHAT_SECURITY_HEADER },
  );
  checkApi(data, 'List members', DOMAIN);

  const raw = data.data?.items || [];
  const items = excludeBots ? raw.filter((m) => !isBotMember(m)) : raw;
  const filteredBotCount = excludeBots ? raw.length - items.length : 0;

  const reply = excludeBots && filteredBotCount > 0
    ? `本页共 ${items.length} 名成员（已排除机器人 ${filteredBotCount} 个）。`
    : `本页共 ${items.length} 名成员。`;

  return {
    action: 'list_members',
    items,
    member_total: data.data?.member_total,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    filtered_bot_count: filteredBotCount,
    reply,
  };
}

export const ACTIONS = {
  search,
  get,
  list_members: listMembers,
};

export { FeishuError };
