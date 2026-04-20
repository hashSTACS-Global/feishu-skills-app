/**
 * tools/lib/search-user.mjs — Feishu user search (search / get_me / get).
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'search-user' };

const VALID_USER_ID_TYPES = ['open_id', 'union_id', 'user_id'];

export async function search(args, token) {
  requireParam(args, 'query', '姓名/手机号/邮箱');
  let pageSize;
  if (args.page_size !== undefined) {
    if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 200) {
      throw new FeishuError('invalid_param', 'page_size 必须是 1-200 的整数', { param: 'page_size' });
    }
    pageSize = args.page_size;
  }
  const query = { query: args.query };
  if (pageSize !== undefined) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall('GET', '/search/v1/user', token, { query });
  checkApi(data, 'Search user', DOMAIN);

  const users = (data.data?.users || []).map((u) => ({
    open_id: u.open_id,
    name: u.name,
    en_name: u.en_name,
    department: u.department_ids,
    avatar: u.avatar?.avatar_72,
  }));

  return {
    action: 'search',
    users,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: users.length > 0
      ? `找到 ${users.length} 位用户：${users.map((u) => u.name).join('、')}`
      : `未找到匹配「${args.query}」的用户`,
  };
}

export async function get_me(_args, token) {
  const data = await apiCall('GET', '/authen/v1/user_info', token);
  checkApi(data, 'Get me', DOMAIN);
  const u = data.data || {};
  const user = {
    open_id: u.open_id,
    union_id: u.union_id,
    name: u.name,
    en_name: u.en_name,
    email: u.email,
    mobile: u.mobile,
    avatar: u.avatar_url,
  };
  return { action: 'get_me', user, reply: `当前用户：${user.name}（${user.open_id}）` };
}

export async function get(args, token) {
  requireParam(args, 'user_id');
  let userIdType = args.user_id_type ?? 'open_id';
  if (!VALID_USER_ID_TYPES.includes(userIdType)) {
    throw new FeishuError(
      'invalid_param',
      `user_id_type 必须是 ${VALID_USER_ID_TYPES.join(' / ')} 之一`,
      { param: 'user_id_type', got: userIdType },
    );
  }
  const data = await apiCall('GET', `/contact/v3/users/${encodeURIComponent(args.user_id)}`, token, {
    query: { user_id_type: userIdType },
  });
  if (data.code === 41050) {
    throw new FeishuError(
      'permission_required',
      '无权限查询该用户信息（用户不在当前组织架构可见范围）',
      {
        feishu_code: 41050,
        auth_type: 'tenant',
        reply: '**权限不足：该用户不在您的组织架构可见范围内，无法查询其信息**',
      },
    );
  }
  checkApi(data, 'Get user', DOMAIN);
  const u = data.data?.user || {};
  const user = {
    open_id: u.open_id,
    union_id: u.union_id,
    user_id: u.user_id,
    name: u.name,
    en_name: u.en_name,
    email: u.email,
    mobile: u.mobile,
    department_ids: u.department_ids,
    avatar: u.avatar?.avatar_72,
  };
  return { action: 'get', user, reply: `用户信息：${user.name}（${user.open_id}）` };
}

export const ACTIONS = { search, get_me, get };
export { FeishuError };
