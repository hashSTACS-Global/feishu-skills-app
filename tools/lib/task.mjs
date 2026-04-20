/**
 * tools/lib/task.mjs — Feishu task management (tasks / tasklists / comments / subtasks).
 *
 * Contract:
 *   - members / followers are arrays of open_id strings (no comma-string coercion).
 *   - completed is a boolean (no string "true"/"false" coercion).
 *   - No automatic reminder calculation — caller specifies reminders explicitly.
 *   - No side-effect sendCard — use im-message pipeline separately if needed.
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'task' };

function toTimestampMs(v, label) {
  const t = new Date(v).getTime();
  if (Number.isNaN(t)) {
    throw new FeishuError('invalid_param', `${label} 无法解析为时间: ${v}`, { param: label });
  }
  return String(t);
}

function requireBool(args, key) {
  if (args[key] === undefined) return undefined;
  if (typeof args[key] !== 'boolean') {
    throw new FeishuError('invalid_param', `${key} 必须是 boolean`, { param: key, got: typeof args[key] });
  }
  return args[key];
}

function requireArrayOfStrings(args, key, hint) {
  if (args[key] === undefined) return undefined;
  if (!Array.isArray(args[key])) {
    throw new FeishuError('invalid_param', `${key} 必须是字符串数组${hint ? `（${hint}）` : ''}`, { param: key, got: typeof args[key] });
  }
  args[key].forEach((v, i) => {
    if (typeof v !== 'string' || !v.trim()) {
      throw new FeishuError('invalid_param', `${key}[${i}] 必须是非空字符串`, { param: `${key}[${i}]` });
    }
  });
  return args[key];
}

function requirePageSize(args, max = 500) {
  if (args.page_size === undefined) return null;
  if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > max) {
    throw new FeishuError('invalid_param', `page_size 必须是 1-${max} 的整数`, { param: 'page_size', max });
  }
  return args.page_size;
}

// ---------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------

export async function create_task(args, token) {
  requireParam(args, 'summary', '任务标题');
  const body = { summary: args.summary };
  if (args.description) body.description = args.description;
  if (args.due) body.due = { timestamp: toTimestampMs(args.due, 'due'), is_all_day: !!args.is_all_day };
  if (args.reminders !== undefined) {
    if (!Array.isArray(args.reminders)) {
      throw new FeishuError('invalid_param', 'reminders 必须是数组，形如 [{"relative_fire_minute": 15}]', { param: 'reminders' });
    }
    body.reminders = args.reminders;
  }

  const memberIds = requireArrayOfStrings(args, 'members', 'open_id 数组，作为负责人');
  const followerIds = requireArrayOfStrings(args, 'followers', 'open_id 数组，作为关注人');
  const members = [];
  if (memberIds) memberIds.forEach((id) => members.push({ id, type: 'user', role: 'assignee' }));
  if (followerIds) followerIds.forEach((id) => members.push({ id, type: 'user', role: 'follower' }));
  if (members.length > 0) body.members = members;

  if (args.tasklist_id) body.tasklists = [{ tasklist_id: args.tasklist_id }];

  const data = await apiCall('POST', '/task/v2/tasks', token, { body, query: { user_id_type: 'open_id' } });
  checkApi(data, 'Create task', DOMAIN);
  const task = data.data?.task;
  return { action: 'create_task', task, url: task?.url || null, reply: `任务「${args.summary}」已创建` };
}

export async function get_task(args, token) {
  requireParam(args, 'task_id');
  const data = await apiCall('GET', `/task/v2/tasks/${encodeURIComponent(args.task_id)}`, token, { query: { user_id_type: 'open_id' } });
  checkApi(data, 'Get task', DOMAIN);
  return { action: 'get_task', task: data.data?.task };
}

export async function list_tasks(args, token) {
  const pageSize = requirePageSize(args, 200);
  const completed = requireBool(args, 'completed');
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  if (completed !== undefined) query.completed = String(completed);
  const data = await apiCall('GET', '/task/v2/tasks', token, { query });
  checkApi(data, 'List tasks', DOMAIN);
  const tasks = data.data?.items || [];
  return {
    action: 'list_tasks',
    tasks,
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
    reply: tasks.length === 0 ? '暂无任务' : `共 ${tasks.length} 条任务`,
  };
}

export async function update_task(args, token) {
  requireParam(args, 'task_id');
  const task = {};
  if (args.summary !== undefined) task.summary = args.summary;
  if (args.description !== undefined) task.description = args.description;
  if (args.due !== undefined) task.due = { timestamp: toTimestampMs(args.due, 'due'), is_all_day: !!args.is_all_day };
  const completed = requireBool(args, 'completed');
  if (completed !== undefined) task.completed_at = completed ? String(Date.now()) : '0';
  const update_fields = Object.keys(task);
  if (update_fields.length === 0) {
    throw new FeishuError('missing_param', '至少指定一个要更新的字段', { params: ['summary', 'description', 'due', 'completed'] });
  }
  const data = await apiCall(
    'PATCH',
    `/task/v2/tasks/${encodeURIComponent(args.task_id)}`,
    token,
    { body: { task, update_fields }, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Update task', DOMAIN);
  const updated = data.data?.task;
  return {
    action: 'update_task',
    task: updated,
    url: updated?.url || null,
    reply: completed === true ? '任务已完成' : completed === false ? '任务已恢复为未完成' : '任务已更新',
  };
}

async function alterTaskMembers(endpoint, role, args, token) {
  requireParam(args, 'task_id');
  const members = requireArrayOfStrings(args, role === 'assignee' ? 'members' : 'followers', `${role === 'assignee' ? '负责人' : '关注人'} open_id 数组`);
  if (!members) {
    throw new FeishuError(
      'missing_param',
      `${role === 'assignee' ? 'members' : 'followers'} 必填`,
      { param: role === 'assignee' ? 'members' : 'followers' },
    );
  }
  const body = { members: members.map((id) => ({ id, type: 'user', role })) };
  const data = await apiCall(
    'POST',
    `/task/v2/tasks/${encodeURIComponent(args.task_id)}/${endpoint}`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, `${endpoint} (${role})`, DOMAIN);
  return data.data?.task;
}

export async function add_task_members(args, token) {
  const task = await alterTaskMembers('add_members', 'assignee', args, token);
  return { action: 'add_task_members', task, reply: '成员已添加' };
}

export async function remove_task_members(args, token) {
  const task = await alterTaskMembers('remove_members', 'assignee', args, token);
  return { action: 'remove_task_members', task, reply: '成员已移除' };
}

export async function add_followers(args, token) {
  const task = await alterTaskMembers('add_members', 'follower', args, token);
  return { action: 'add_followers', task, reply: '关注人已添加' };
}

export async function remove_followers(args, token) {
  const task = await alterTaskMembers('remove_members', 'follower', args, token);
  return { action: 'remove_followers', task, reply: '关注人已移除' };
}

// ---------------------------------------------------------------------------
// Tasklist actions
// ---------------------------------------------------------------------------

export async function create_tasklist(args, token) {
  requireParam(args, 'name', '清单名称');
  const data = await apiCall('POST', '/task/v2/tasklists', token, { body: { name: args.name }, query: { user_id_type: 'open_id' } });
  checkApi(data, 'Create tasklist', DOMAIN);
  return { action: 'create_tasklist', tasklist: data.data?.tasklist, reply: `任务清单「${args.name}」已创建` };
}

export async function get_tasklist(args, token) {
  requireParam(args, 'tasklist_id');
  const data = await apiCall('GET', `/task/v2/tasklists/${encodeURIComponent(args.tasklist_id)}`, token, { query: { user_id_type: 'open_id' } });
  checkApi(data, 'Get tasklist', DOMAIN);
  return { action: 'get_tasklist', tasklist: data.data?.tasklist };
}

export async function list_tasklists(args, token) {
  const pageSize = requirePageSize(args, 200);
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', '/task/v2/tasklists', token, { query });
  checkApi(data, 'List tasklists', DOMAIN);
  return {
    action: 'list_tasklists',
    tasklists: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export async function update_tasklist(args, token) {
  requireParam(args, 'tasklist_id');
  requireParam(args, 'name', '新的清单名称');
  const data = await apiCall(
    'PATCH',
    `/task/v2/tasklists/${encodeURIComponent(args.tasklist_id)}`,
    token,
    { body: { name: args.name }, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Update tasklist', DOMAIN);
  return { action: 'update_tasklist', tasklist: data.data?.tasklist, reply: '任务清单已更新' };
}

export async function delete_tasklist(args, token) {
  requireParam(args, 'tasklist_id');
  const data = await apiCall('DELETE', `/task/v2/tasklists/${encodeURIComponent(args.tasklist_id)}`, token);
  checkApi(data, 'Delete tasklist', DOMAIN);
  return { action: 'delete_tasklist', success: true, reply: '任务清单已删除' };
}

export async function list_tasklist_tasks(args, token) {
  requireParam(args, 'tasklist_id');
  const pageSize = requirePageSize(args, 200);
  const completed = requireBool(args, 'completed');
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  if (completed !== undefined) query.completed = String(completed);
  const data = await apiCall('GET', `/task/v2/tasklists/${encodeURIComponent(args.tasklist_id)}/tasks`, token, { query });
  checkApi(data, 'List tasklist tasks', DOMAIN);
  return {
    action: 'list_tasklist_tasks',
    tasks: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

async function alterTasklistMembers(endpoint, args, token) {
  requireParam(args, 'tasklist_id');
  const members = requireArrayOfStrings(args, 'members', 'open_id 数组');
  if (!members) throw new FeishuError('missing_param', 'members 必填', { param: 'members' });
  const body = { members: members.map((id) => ({ id, type: 'user', role: 'editor' })) };
  const data = await apiCall(
    'POST',
    `/task/v2/tasklists/${encodeURIComponent(args.tasklist_id)}/${endpoint}`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, `Tasklist ${endpoint}`, DOMAIN);
  return data.data?.tasklist;
}

export async function add_tasklist_members(args, token) {
  const tasklist = await alterTasklistMembers('add_members', args, token);
  return { action: 'add_tasklist_members', tasklist, reply: '清单成员已添加' };
}

export async function remove_tasklist_members(args, token) {
  const tasklist = await alterTasklistMembers('remove_members', args, token);
  return { action: 'remove_tasklist_members', tasklist, reply: '清单成员已移除' };
}

// ---------------------------------------------------------------------------
// Comment / Subtask
// ---------------------------------------------------------------------------

export async function create_comment(args, token) {
  requireParam(args, 'task_id');
  requireParam(args, 'content');
  const data = await apiCall(
    'POST',
    `/task/v2/tasks/${encodeURIComponent(args.task_id)}/comments`,
    token,
    { body: { content: args.content }, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Create comment', DOMAIN);
  return { action: 'create_comment', comment: data.data?.comment, reply: '评论已添加' };
}

export async function list_comments(args, token) {
  requireParam(args, 'task_id');
  const pageSize = requirePageSize(args, 200);
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/task/v2/tasks/${encodeURIComponent(args.task_id)}/comments`, token, { query });
  checkApi(data, 'List comments', DOMAIN);
  return {
    action: 'list_comments',
    comments: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export async function get_comment(args, token) {
  requireParam(args, 'task_id');
  requireParam(args, 'comment_id');
  const data = await apiCall(
    'GET',
    `/task/v2/tasks/${encodeURIComponent(args.task_id)}/comments/${encodeURIComponent(args.comment_id)}`,
    token,
    { query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Get comment', DOMAIN);
  return { action: 'get_comment', comment: data.data?.comment };
}

export async function create_subtask(args, token) {
  requireParam(args, 'task_id');
  requireParam(args, 'summary', '子任务标题');
  const body = { summary: args.summary };
  if (args.description) body.description = args.description;
  if (args.due) body.due = { timestamp: toTimestampMs(args.due, 'due'), is_all_day: !!args.is_all_day };
  const data = await apiCall(
    'POST',
    `/task/v2/tasks/${encodeURIComponent(args.task_id)}/subtasks`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Create subtask', DOMAIN);
  return { action: 'create_subtask', task: data.data?.task, reply: `子任务「${args.summary}」已创建` };
}

export async function list_subtasks(args, token) {
  requireParam(args, 'task_id');
  const pageSize = requirePageSize(args, 200);
  const query = { user_id_type: 'open_id' };
  if (pageSize !== null) query.page_size = String(pageSize);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/task/v2/tasks/${encodeURIComponent(args.task_id)}/subtasks`, token, { query });
  checkApi(data, 'List subtasks', DOMAIN);
  return {
    action: 'list_subtasks',
    tasks: data.data?.items || [],
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

export const ACTIONS = {
  create_task,
  get_task,
  list_tasks,
  update_task,
  add_task_members,
  remove_task_members,
  add_followers,
  remove_followers,
  create_tasklist,
  get_tasklist,
  list_tasklists,
  update_tasklist,
  delete_tasklist,
  list_tasklist_tasks,
  add_tasklist_members,
  remove_tasklist_members,
  create_comment,
  list_comments,
  get_comment,
  create_subtask,
  list_subtasks,
};

export { FeishuError };
