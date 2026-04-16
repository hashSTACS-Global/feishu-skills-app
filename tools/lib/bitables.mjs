/**
 * tools/lib/bitables.mjs — Feishu Bitable operations, refactored from
 * feishu-skills/feishu-bitable/bitables.mjs as pure async functions.
 *
 * 25 actions across 5 categories: App / Table / Field / Record / View.
 *
 * Input convention (snake_case to match pipeline input schema):
 *   app_token, table_id, field_id, record_id, view_id, name,
 *   fields (object), records (array), filter, sort, page_size, page_token,
 *   folder_token, field_type (number), property (object), view_type,
 *   record_ids (array or comma-string), table_ids, table_names
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
      if (v !== undefined && v !== null) params.set(k, String(v));
    }
    const qs = params.toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch { throw new FeishuError('api_error', `API parse error: ${res.status} ${res.statusText}`); }
  return data;
}

function checkApi(data, opName) {
  if (data.code === 0) return data;
  const msg = `${opName} failed: code=${data.code} msg=${data.msg}`;
  if (data.code === 99991663) throw new FeishuError('auth_required', '飞书 token 已失效，请重新授权');
  if (data.code === 99991400) throw new FeishuError('rate_limited', msg);
  if (data.code === 99991672 || data.code === 99991679 || /permission|scope|not support|tenant/i.test(data.msg || '')) {
    throw new FeishuError('permission_required', msg, {
      required_scopes: ['bitable:app', 'drive:drive'],
      reply: '⚠️ 权限不足，需要重新授权获取多维表格权限',
    });
  }
  throw new FeishuError('api_error', msg);
}

function requireAppToken(args) {
  if (!args.app_token) throw new FeishuError('missing_param', 'app_token 必填');
}
function requireTableId(args) {
  requireAppToken(args);
  if (!args.table_id) throw new FeishuError('missing_param', 'table_id 必填');
}

// Accept either array or comma-separated string for *_ids fields
function asArray(val) {
  if (Array.isArray(val)) return val.map(String).map(s => s.trim()).filter(Boolean);
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

async function createApp(args, token) {
  const body = { name: args.name || '未命名多维表格' };
  if (args.folder_token) body.folder_token = args.folder_token;
  const data = await apiCall('POST', '/bitable/v1/apps', token, body);
  checkApi(data, 'Create app');
  return { app: data.data?.app, reply: `多维表格「${args.name || '未命名'}」已创建` };
}

async function getApp(args, token) {
  requireAppToken(args);
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}`, token);
  checkApi(data, 'Get app');
  return { app: data.data?.app };
}

async function updateApp(args, token) {
  requireAppToken(args);
  const body = {};
  if (args.name) body.name = args.name;
  const data = await apiCall('PUT', `/bitable/v1/apps/${args.app_token}`, token, body);
  checkApi(data, 'Update app');
  return { app: data.data?.app, reply: '多维表格已更新' };
}

async function copyApp(args, token) {
  requireAppToken(args);
  const body = { name: args.name || '副本' };
  if (args.folder_token) body.folder_token = args.folder_token;
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/copy`, token, body);
  checkApi(data, 'Copy app');
  return { app: data.data?.app, reply: '多维表格已复制' };
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

async function createTable(args, token) {
  requireAppToken(args);
  const body = { table: { name: args.name || '未命名表格' } };
  if (args.fields) body.table.fields = args.fields;
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables`, token, body);
  checkApi(data, 'Create table');
  return { table_id: data.data?.table_id, reply: `表格「${args.name || '未命名'}」已创建` };
}

async function listTables(args, token) {
  requireAppToken(args);
  const query = { page_size: String(args.page_size || 100) };
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables`, token, null, query);
  checkApi(data, 'List tables');
  return { tables: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function deleteTable(args, token) {
  requireTableId(args);
  const data = await apiCall('DELETE', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}`, token);
  checkApi(data, 'Delete table');
  return { success: true, reply: '表格已删除' };
}

async function updateTable(args, token) {
  requireTableId(args);
  const body = {};
  if (args.name) body.name = args.name;
  const data = await apiCall('PATCH', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}`, token, body);
  checkApi(data, 'Update table');
  return { success: true, reply: '表格已更新' };
}

async function batchCreateTables(args, token) {
  requireAppToken(args);
  const names = asArray(args.table_names);
  if (!names.length) throw new FeishuError('missing_param', 'table_names 必填（数组或逗号分隔）');
  const body = { tables: names.map(n => ({ name: n })) };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/batch_create`, token, body);
  checkApi(data, 'Batch create tables');
  return { table_ids: data.data?.table_ids, reply: `${names.length} 个表格已创建` };
}

async function batchDeleteTables(args, token) {
  requireAppToken(args);
  const ids = asArray(args.table_ids);
  if (!ids.length) throw new FeishuError('missing_param', 'table_ids 必填（数组或逗号分隔）');
  const body = { table_ids: ids };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/batch_delete`, token, body);
  checkApi(data, 'Batch delete tables');
  return { success: true, reply: `${ids.length} 个表格已删除` };
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

async function createField(args, token) {
  requireTableId(args);
  const body = {
    field_name: args.name || '未命名字段',
    type: args.field_type || 1,
  };
  if (args.property) body.property = args.property;
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields`, token, body);
  checkApi(data, 'Create field');
  return { field: data.data?.field, reply: `字段「${args.name || '未命名'}」已创建` };
}

async function listFields(args, token) {
  requireTableId(args);
  const query = { page_size: String(args.page_size || 100) };
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields`, token, null, query);
  checkApi(data, 'List fields');
  return { fields: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function updateField(args, token) {
  requireTableId(args);
  if (!args.field_id) throw new FeishuError('missing_param', 'field_id 必填');
  const body = {};
  if (args.name) body.field_name = args.name;
  if (args.field_type) body.type = args.field_type;
  if (args.property) body.property = args.property;
  const data = await apiCall('PUT', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields/${args.field_id}`, token, body);
  checkApi(data, 'Update field');
  return { field: data.data?.field, reply: '字段已更新' };
}

async function deleteField(args, token) {
  requireTableId(args);
  if (!args.field_id) throw new FeishuError('missing_param', 'field_id 必填');
  const data = await apiCall('DELETE', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields/${args.field_id}`, token);
  checkApi(data, 'Delete field');
  return { success: true, reply: '字段已删除' };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

async function createRecord(args, token) {
  requireTableId(args);
  if (!args.fields || typeof args.fields !== 'object') {
    throw new FeishuError('missing_param', 'fields 必填（对象）');
  }
  const body = { fields: args.fields };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`, token, body, { user_id_type: 'open_id' });
  checkApi(data, 'Create record');
  return { record: data.data?.record, reply: '记录已创建' };
}

async function listRecords(args, token) {
  requireTableId(args);
  const query = { page_size: String(Math.min(args.page_size || 100, 500)), user_id_type: 'open_id' };
  if (args.page_token) query.page_token = args.page_token;
  if (args.view_id) query.view_id = args.view_id;
  if (args.filter) query.filter = args.filter;
  if (args.sort) query.sort = args.sort;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`, token, null, query);
  checkApi(data, 'List records');
  return { records: data.data?.items || [], total: data.data?.total, has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function updateRecord(args, token) {
  requireTableId(args);
  if (!args.record_id) throw new FeishuError('missing_param', 'record_id 必填');
  if (!args.fields || typeof args.fields !== 'object') throw new FeishuError('missing_param', 'fields 必填（对象）');
  const body = { fields: args.fields };
  const data = await apiCall('PUT', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/${args.record_id}`, token, body, { user_id_type: 'open_id' });
  checkApi(data, 'Update record');
  return { record: data.data?.record, reply: '记录已更新' };
}

async function deleteRecord(args, token) {
  requireTableId(args);
  if (!args.record_id) throw new FeishuError('missing_param', 'record_id 必填');
  const data = await apiCall('DELETE', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/${args.record_id}`, token);
  checkApi(data, 'Delete record');
  return { success: true, reply: '记录已删除' };
}

async function batchCreateRecords(args, token) {
  requireTableId(args);
  if (!Array.isArray(args.records)) throw new FeishuError('missing_param', 'records 必填（数组，每项为 fields 对象）');
  const body = { records: args.records.map(r => ({ fields: r.fields || r })) };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_create`, token, body, { user_id_type: 'open_id' });
  checkApi(data, 'Batch create records');
  return { records: data.data?.records, reply: `${args.records.length} 条记录已创建` };
}

async function batchUpdateRecords(args, token) {
  requireTableId(args);
  if (!Array.isArray(args.records)) throw new FeishuError('missing_param', 'records 必填（数组，含 record_id 和 fields）');
  const body = { records: args.records };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_update`, token, body, { user_id_type: 'open_id' });
  checkApi(data, 'Batch update records');
  return { records: data.data?.records, reply: `${args.records.length} 条记录已更新` };
}

async function batchDeleteRecords(args, token) {
  requireTableId(args);
  const ids = asArray(args.record_ids);
  if (!ids.length) throw new FeishuError('missing_param', 'record_ids 必填（数组或逗号分隔）');
  const body = { records: ids };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_delete`, token, body);
  checkApi(data, 'Batch delete records');
  return { success: true, reply: `${ids.length} 条记录已删除` };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

async function createView(args, token) {
  requireTableId(args);
  const body = {
    view_name: args.name || '未命名视图',
    view_type: args.view_type || 'grid',
  };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views`, token, body);
  checkApi(data, 'Create view');
  return { view: data.data?.view, reply: `视图「${args.name || '未命名'}」已创建` };
}

async function listViews(args, token) {
  requireTableId(args);
  const query = { page_size: String(args.page_size || 100) };
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views`, token, null, query);
  checkApi(data, 'List views');
  return { views: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function getView(args, token) {
  requireTableId(args);
  if (!args.view_id) throw new FeishuError('missing_param', 'view_id 必填');
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`, token);
  checkApi(data, 'Get view');
  return { view: data.data?.view };
}

async function updateView(args, token) {
  requireTableId(args);
  if (!args.view_id) throw new FeishuError('missing_param', 'view_id 必填');
  const body = {};
  if (args.name) body.view_name = args.name;
  if (args.property) body.property = args.property;
  const data = await apiCall('PATCH', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`, token, body);
  checkApi(data, 'Update view');
  return { view: data.data?.view, reply: '视图已更新' };
}

async function deleteView(args, token) {
  requireTableId(args);
  if (!args.view_id) throw new FeishuError('missing_param', 'view_id 必填');
  const data = await apiCall('DELETE', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`, token);
  checkApi(data, 'Delete view');
  return { success: true, reply: '视图已删除' };
}

// ---------------------------------------------------------------------------
// Dispatcher (handler signature: (args, token) -> Promise<resultObj>)
// ---------------------------------------------------------------------------

export const ACTIONS = {
  create_app: createApp, get_app: getApp, update_app: updateApp, copy_app: copyApp,
  create_table: createTable, list_tables: listTables, delete_table: deleteTable,
  update_table: updateTable, batch_create_tables: batchCreateTables, batch_delete_tables: batchDeleteTables,
  create_field: createField, list_fields: listFields, update_field: updateField, delete_field: deleteField,
  create_record: createRecord, list_records: listRecords, update_record: updateRecord, delete_record: deleteRecord,
  batch_create_records: batchCreateRecords, batch_update_records: batchUpdateRecords, batch_delete_records: batchDeleteRecords,
  create_view: createView, list_views: listViews, get_view: getView, update_view: updateView, delete_view: deleteView,
};

export { FeishuError };
