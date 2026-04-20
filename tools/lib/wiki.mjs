/**
 * tools/lib/wiki.mjs — Feishu Wiki space / node management.
 *
 * Actions: space_list, space_get, space_create,
 *          node_list, node_get, node_create, node_move, node_copy.
 *
 * Contract:
 *   - node_create: obj_type + node_type must be explicit (no inference).
 *   - Token parameter names match Feishu API exactly (node_token vs obj_token).
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'wiki' };

const VALID_OBJ_TYPES = ['doc', 'docx', 'sheet', 'bitable', 'mindnote', 'file', 'slides'];
const VALID_NODE_TYPES = ['origin', 'shortcut'];

function requirePageSize(args, max = 50) {
  if (args.page_size === undefined) return null;
  if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > max) {
    throw new FeishuError('invalid_param', `page_size 必须是 1-${max} 的整数`, { param: 'page_size', max });
  }
  return args.page_size;
}

// ---------------------------------------------------------------------------
// Space
// ---------------------------------------------------------------------------

export async function space_list(args, token) {
  const pageSize = requirePageSize(args);
  const query = {};
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', '/wiki/v2/spaces', token, { query });
  checkApi(data, 'List wiki spaces', DOMAIN);
  const spaces = data.data?.items || [];
  return {
    action: 'space_list',
    spaces,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: spaces.length > 0
      ? `找到 ${spaces.length} 个知识空间：${spaces.map((s) => `${s.name}（${s.space_id}）`).join('、')}`
      : '未找到知识空间',
  };
}

export async function space_get(args, token) {
  requireParam(args, 'space_id');
  const data = await apiCall('GET', `/wiki/v2/spaces/${encodeURIComponent(args.space_id)}`, token);
  checkApi(data, 'Get wiki space', DOMAIN);
  const space = data.data?.space;
  return {
    action: 'space_get',
    space,
    reply: space ? `知识空间：${space.name}（${space.space_id}）` : '未找到空间',
  };
}

export async function space_create(args, token) {
  requireParam(args, 'name', '空间名称');
  const body = { name: args.name };
  if (args.description) body.description = args.description;
  const data = await apiCall('POST', '/wiki/v2/spaces', token, { body });
  checkApi(data, 'Create wiki space', DOMAIN);
  const space = data.data?.space;
  return {
    action: 'space_create',
    space,
    reply: `已创建知识空间「${space?.name}」（${space?.space_id}）`,
  };
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

export async function node_list(args, token) {
  requireParam(args, 'space_id');
  const pageSize = requirePageSize(args);
  const query = {};
  if (args.parent_node_token) query.parent_node_token = args.parent_node_token;
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/wiki/v2/spaces/${encodeURIComponent(args.space_id)}/nodes`, token, { query });
  checkApi(data, 'List wiki nodes', DOMAIN);
  const nodes = data.data?.items || [];
  return {
    action: 'node_list',
    nodes,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    reply: `找到 ${nodes.length} 个节点${args.parent_node_token ? '（子节点）' : '（根节点）'}`,
  };
}

export async function node_get(args, token) {
  requireParam(args, 'token', '节点 node_token 或 obj_token');
  const query = { token: args.token };
  if (args.obj_type) query.obj_type = args.obj_type;
  const data = await apiCall('GET', '/wiki/v2/spaces/get_node', token, { query });
  checkApi(data, 'Get wiki node', DOMAIN);
  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  return {
    action: 'node_get',
    node,
    url: wiki_url,
    reply: node
      ? `节点：${node.title}（node_token=${node.node_token}，obj_token=${node.obj_token}，类型=${node.obj_type}）${wiki_url ? `\n链接：${wiki_url}` : ''}`
      : '未找到节点',
  };
}

export async function node_create(args, token) {
  requireParam(args, 'space_id');
  requireParam(args, 'obj_type', `支持: ${VALID_OBJ_TYPES.join(' / ')}`);
  if (!VALID_OBJ_TYPES.includes(args.obj_type)) {
    throw new FeishuError('invalid_param', `obj_type 必须是 ${VALID_OBJ_TYPES.join(' / ')} 之一`, { param: 'obj_type', got: args.obj_type });
  }
  requireParam(args, 'node_type', `支持: ${VALID_NODE_TYPES.join(' / ')}`);
  if (!VALID_NODE_TYPES.includes(args.node_type)) {
    throw new FeishuError('invalid_param', `node_type 必须是 ${VALID_NODE_TYPES.join(' / ')} 之一`, { param: 'node_type', got: args.node_type });
  }
  if (args.node_type === 'shortcut') {
    requireParam(args, 'origin_node_token', 'shortcut 必须指向一个已存在节点');
  }

  const body = { obj_type: args.obj_type, node_type: args.node_type };
  if (args.parent_node_token) body.parent_node_token = args.parent_node_token;
  if (args.origin_node_token) body.origin_node_token = args.origin_node_token;
  if (args.title) body.title = args.title;

  const data = await apiCall('POST', `/wiki/v2/spaces/${encodeURIComponent(args.space_id)}/nodes`, token, { body });
  checkApi(data, 'Create wiki node', DOMAIN);
  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  return {
    action: 'node_create',
    node,
    url: wiki_url,
    reply: `已创建节点「${node?.title ?? args.title ?? '（无标题）'}」${wiki_url ? `：${wiki_url}` : `（node_token=${node?.node_token}）`}`,
  };
}

export async function node_move(args, token) {
  requireParam(args, 'space_id');
  requireParam(args, 'node_token');
  const body = {};
  if (args.target_parent_token) body.target_parent_token = args.target_parent_token;
  const data = await apiCall(
    'POST',
    `/wiki/v2/spaces/${encodeURIComponent(args.space_id)}/nodes/${encodeURIComponent(args.node_token)}/move`,
    token,
    { body },
  );
  checkApi(data, 'Move wiki node', DOMAIN);
  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  return {
    action: 'node_move',
    node,
    url: wiki_url,
    reply: `已移动节点 ${args.node_token} 到 ${args.target_parent_token ?? '根目录'}${wiki_url ? `，链接：${wiki_url}` : ''}`,
  };
}

export async function node_copy(args, token) {
  requireParam(args, 'space_id');
  requireParam(args, 'node_token');
  const body = {};
  if (args.target_space_id) body.target_space_id = args.target_space_id;
  if (args.target_parent_token) body.target_parent_token = args.target_parent_token;
  if (args.title) body.title = args.title;

  const data = await apiCall(
    'POST',
    `/wiki/v2/spaces/${encodeURIComponent(args.space_id)}/nodes/${encodeURIComponent(args.node_token)}/copy`,
    token,
    { body },
  );
  checkApi(data, 'Copy wiki node', DOMAIN);
  const node = data.data?.node;
  const wiki_url = node?.node_token ? `https://www.feishu.cn/wiki/${node.node_token}` : null;
  return {
    action: 'node_copy',
    node,
    url: wiki_url,
    reply: `已复制节点「${node?.title ?? args.title ?? '（无标题）'}」${wiki_url ? `：${wiki_url}` : `（node_token=${node?.node_token}）`}`,
  };
}

export const ACTIONS = {
  space_list,
  space_get,
  space_create,
  node_list,
  node_get,
  node_create,
  node_move,
  node_copy,
};

export { FeishuError };
