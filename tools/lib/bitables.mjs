/**
 * tools/lib/bitables.mjs — Feishu Bitable operations (thin API adapter).
 *
 * 25 actions across 5 categories: App / Table / Field / Record / View.
 *
 * Contract:
 *   - Pure pass-through per Agent Pipeline Protocol. No silent fixes.
 *   - Missing required fields → throws missing_param.
 *   - Wrong-type fields (e.g. options.color as string) → throws invalid_param.
 *   - Feishu API quirks (update_field needs type, options.color must be int, etc.)
 *     are validated up-front so the LLM gets a clear message, not "field validation failed".
 *
 * Input convention (snake_case to match pipeline input schema):
 *   app_token, table_id, field_id, record_id, view_id, name,
 *   fields (array/object), records (array), filter, sort, page_size, page_token,
 *   folder_token, field_type (number), property (object), view_type,
 *   record_ids (array), table_ids (array), table_names (array)
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'bitable' };

// ---------------------------------------------------------------------------
// Validators
// ---------------------------------------------------------------------------

const requireAppToken = (args) => requireParam(args, 'app_token');
const requireTableId = (args) => {
  requireParam(args, 'app_token');
  requireParam(args, 'table_id');
};

function requireArray(args, key, hint) {
  const v = args?.[key];
  if (!Array.isArray(v)) {
    throw new FeishuError(
      'invalid_param',
      hint ? `${key} 必须是数组（${hint}）` : `${key} 必须是数组`,
      { param: key, got: typeof v },
    );
  }
  if (v.length === 0) {
    throw new FeishuError('missing_param', `${key} 不能为空数组`, { param: key });
  }
  return v;
}

/**
 * Validate single-select / multi-select options[].color.
 * Feishu spec: integer 0-54. String colors (e.g. "red") are rejected.
 */
function validateOptionsColor(options, fieldLabel) {
  if (!Array.isArray(options)) return;
  options.forEach((opt, i) => {
    if (opt === null || typeof opt !== 'object') return;
    if (opt.color === undefined) return;
    if (typeof opt.color !== 'number') {
      throw new FeishuError(
        'invalid_param',
        `${fieldLabel}.options[${i}].color 必须是整数 0-54，不能是字符串（got ${typeof opt.color}）。飞书 API 规范：single/multi_select 的颜色用 0-54 数字索引，例如 0=红、1=橙、2=黄、3=绿`,
        { param: `${fieldLabel}.options[${i}].color`, got: opt.color },
      );
    }
    if (!Number.isInteger(opt.color) || opt.color < 0 || opt.color > 54) {
      throw new FeishuError(
        'invalid_param',
        `${fieldLabel}.options[${i}].color 必须是 0-54 之间的整数（got ${opt.color}）`,
        { param: `${fieldLabel}.options[${i}].color`, got: opt.color },
      );
    }
  });
}

/** Validate a field-property object against its declared field_type. */
function validateFieldProperty(fieldType, property, fieldLabel) {
  if (property === undefined || property === null) return;
  if (typeof property !== 'object' || Array.isArray(property)) {
    throw new FeishuError('invalid_param', `${fieldLabel} 必须是对象`, { param: fieldLabel });
  }
  // type 3 = single select, 4 = multi select
  if ((fieldType === 3 || fieldType === 4) && property.options !== undefined) {
    if (!Array.isArray(property.options)) {
      throw new FeishuError(
        'invalid_param',
        `${fieldLabel}.options 必须是数组`,
        { param: `${fieldLabel}.options` },
      );
    }
    validateOptionsColor(property.options, fieldLabel);
  }
}

/** Validate a single field object used in createTable(fields) / createField. */
function validateFieldDef(field, index) {
  const label = `fields[${index}]`;
  if (!field || typeof field !== 'object') {
    throw new FeishuError('invalid_param', `${label} 必须是对象`, { param: label });
  }
  if (!field.field_name || typeof field.field_name !== 'string') {
    throw new FeishuError('missing_param', `${label}.field_name 必填（字符串）`, { param: `${label}.field_name` });
  }
  if (field.type === undefined || field.type === null) {
    throw new FeishuError('missing_param', `${label}.type 必填（飞书字段类型数字，如 1=文本 / 3=单选 / 5=日期 / 11=人员）`, { param: `${label}.type` });
  }
  if (!Number.isInteger(field.type)) {
    throw new FeishuError('invalid_param', `${label}.type 必须是整数，got ${typeof field.type}`, { param: `${label}.type`, got: field.type });
  }
  validateFieldProperty(field.type, field.property, `${label}.property`);
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

async function createApp(args, token) {
  requireParam(args, 'name');
  const body = { name: args.name };
  if (args.folder_token) body.folder_token = args.folder_token;
  const data = await apiCall('POST', '/bitable/v1/apps', token, { body });
  checkApi(data, 'Create app', DOMAIN);
  return { app: data.data?.app, reply: `多维表格「${args.name}」已创建` };
}

async function getApp(args, token) {
  requireAppToken(args);
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}`, token);
  checkApi(data, 'Get app', DOMAIN);
  return { app: data.data?.app };
}

async function updateApp(args, token) {
  requireAppToken(args);
  requireParam(args, 'name', '至少传一个要更新的字段');
  const body = { name: args.name };
  const data = await apiCall('PUT', `/bitable/v1/apps/${args.app_token}`, token, { body });
  checkApi(data, 'Update app', DOMAIN);
  return { app: data.data?.app, reply: '多维表格已更新' };
}

async function copyApp(args, token) {
  requireAppToken(args);
  requireParam(args, 'name', '副本名称');
  const body = { name: args.name };
  if (args.folder_token) body.folder_token = args.folder_token;
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/copy`, token, { body });
  checkApi(data, 'Copy app', DOMAIN);
  return { app: data.data?.app, reply: '多维表格已复制' };
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

async function createTable(args, token) {
  requireAppToken(args);
  requireParam(args, 'name', '表格名称');
  const body = { table: { name: args.name } };
  if (args.fields !== undefined) {
    if (!Array.isArray(args.fields)) {
      throw new FeishuError('invalid_param', 'fields 必须是数组', { param: 'fields' });
    }
    args.fields.forEach(validateFieldDef);
    body.table.fields = args.fields;
  }
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables`, token, { body });
  checkApi(data, 'Create table', DOMAIN);
  return { table_id: data.data?.table_id, reply: `表格「${args.name}」已创建` };
}

async function listTables(args, token) {
  requireAppToken(args);
  const query = {};
  if (args.page_size !== undefined) query.page_size = String(args.page_size);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables`, token, { query });
  checkApi(data, 'List tables', DOMAIN);
  return { tables: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function deleteTable(args, token) {
  requireTableId(args);
  const data = await apiCall('DELETE', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}`, token);
  checkApi(data, 'Delete table', DOMAIN);
  return { success: true, reply: '表格已删除' };
}

async function updateTable(args, token) {
  requireTableId(args);
  requireParam(args, 'name', '至少传一个要更新的字段');
  const body = { name: args.name };
  const data = await apiCall('PATCH', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}`, token, { body });
  checkApi(data, 'Update table', DOMAIN);
  return { success: true, reply: '表格已更新' };
}

async function batchCreateTables(args, token) {
  requireAppToken(args);
  const names = requireArray(args, 'table_names', '字符串数组');
  names.forEach((n, i) => {
    if (typeof n !== 'string' || !n.trim()) {
      throw new FeishuError('invalid_param', `table_names[${i}] 必须是非空字符串`, { param: `table_names[${i}]` });
    }
  });
  const body = { tables: names.map((n) => ({ name: n })) };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/batch_create`, token, { body });
  checkApi(data, 'Batch create tables', DOMAIN);
  return { table_ids: data.data?.table_ids, reply: `${names.length} 个表格已创建` };
}

async function batchDeleteTables(args, token) {
  requireAppToken(args);
  const ids = requireArray(args, 'table_ids', 'table_id 数组');
  const body = { table_ids: ids };
  const data = await apiCall('POST', `/bitable/v1/apps/${args.app_token}/tables/batch_delete`, token, { body });
  checkApi(data, 'Batch delete tables', DOMAIN);
  return { success: true, reply: `${ids.length} 个表格已删除` };
}

// ---------------------------------------------------------------------------
// Field
// ---------------------------------------------------------------------------

async function createField(args, token) {
  requireTableId(args);
  requireParam(args, 'name', '字段名称');
  requireParam(args, 'field_type', '飞书字段类型数字，如 1=文本 / 2=数字 / 3=单选 / 4=多选 / 5=日期 / 7=复选框 / 11=人员 / 15=URL / 17=附件');
  if (!Number.isInteger(args.field_type)) {
    throw new FeishuError('invalid_param', `field_type 必须是整数，got ${typeof args.field_type}`, { param: 'field_type' });
  }
  validateFieldProperty(args.field_type, args.property, 'property');

  const body = { field_name: args.name, type: args.field_type };
  if (args.property !== undefined) body.property = args.property;

  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields`,
    token,
    { body },
  );
  checkApi(data, 'Create field', DOMAIN);
  return { field: data.data?.field, reply: `字段「${args.name}」已创建` };
}

async function listFields(args, token) {
  requireTableId(args);
  const query = {};
  if (args.page_size !== undefined) query.page_size = String(args.page_size);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields`, token, { query });
  checkApi(data, 'List fields', DOMAIN);
  return { fields: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function updateField(args, token) {
  requireTableId(args);
  requireParam(args, 'field_id');
  // Feishu PUT field REQUIRES type in body, even if you're only renaming.
  // We do NOT silently fetch it — force caller (LLM) to be explicit.
  requireParam(
    args,
    'field_type',
    '飞书 update field API 必须带字段类型（可先调 list_fields 查询现有字段的 type）',
  );
  if (!Number.isInteger(args.field_type)) {
    throw new FeishuError('invalid_param', `field_type 必须是整数，got ${typeof args.field_type}`, { param: 'field_type' });
  }
  validateFieldProperty(args.field_type, args.property, 'property');

  const body = { type: args.field_type };
  if (args.name !== undefined) body.field_name = args.name;
  if (args.property !== undefined) body.property = args.property;

  const data = await apiCall(
    'PUT',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields/${args.field_id}`,
    token,
    { body },
  );
  checkApi(data, 'Update field', DOMAIN);
  return { field: data.data?.field, reply: '字段已更新' };
}

async function deleteField(args, token) {
  requireTableId(args);
  requireParam(args, 'field_id');
  const data = await apiCall(
    'DELETE',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/fields/${args.field_id}`,
    token,
  );
  checkApi(data, 'Delete field', DOMAIN);
  return { success: true, reply: '字段已删除' };
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------

function requireRecordFields(args) {
  if (args.fields === undefined || args.fields === null) {
    throw new FeishuError('missing_param', 'fields 必填（对象，键为字段名，值为字段值）', { param: 'fields' });
  }
  if (typeof args.fields !== 'object' || Array.isArray(args.fields)) {
    throw new FeishuError('invalid_param', 'fields 必须是对象（不能是数组/字符串）', { param: 'fields' });
  }
}

async function createRecord(args, token) {
  requireTableId(args);
  requireRecordFields(args);
  const body = { fields: args.fields };
  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Create record', DOMAIN);
  return { record: data.data?.record, reply: '记录已创建' };
}

async function listRecords(args, token) {
  requireTableId(args);
  const query = { user_id_type: 'open_id' };
  if (args.page_size !== undefined) {
    if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 500) {
      throw new FeishuError('invalid_param', 'page_size 必须是 1-500 的整数（飞书 API 上限）', { param: 'page_size' });
    }
    query.page_size = String(args.page_size);
  }
  if (args.page_token) query.page_token = args.page_token;
  if (args.view_id) query.view_id = args.view_id;
  if (args.filter) query.filter = args.filter;
  if (args.sort) query.sort = args.sort;
  const data = await apiCall(
    'GET',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records`,
    token,
    { query },
  );
  checkApi(data, 'List records', DOMAIN);
  return {
    records: data.data?.items || [],
    total: data.data?.total,
    has_more: data.data?.has_more,
    page_token: data.data?.page_token,
  };
}

async function updateRecord(args, token) {
  requireTableId(args);
  requireParam(args, 'record_id');
  requireRecordFields(args);
  const body = { fields: args.fields };
  const data = await apiCall(
    'PUT',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/${args.record_id}`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Update record', DOMAIN);
  return { record: data.data?.record, reply: '记录已更新' };
}

async function deleteRecord(args, token) {
  requireTableId(args);
  requireParam(args, 'record_id');
  const data = await apiCall(
    'DELETE',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/${args.record_id}`,
    token,
  );
  checkApi(data, 'Delete record', DOMAIN);
  return { success: true, reply: '记录已删除' };
}

async function batchCreateRecords(args, token) {
  requireTableId(args);
  const records = requireArray(args, 'records', '数组，每项形如 {fields: {字段名: 字段值, ...}}');
  records.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new FeishuError('invalid_param', `records[${i}] 必须是对象`, { param: `records[${i}]` });
    }
    if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields)) {
      throw new FeishuError(
        'invalid_param',
        `records[${i}].fields 必须是对象。如果你是直接把字段映射放在 records[${i}]，请改为 {fields: {...}} 的形状`,
        { param: `records[${i}].fields` },
      );
    }
  });
  const body = { records: records.map((r) => ({ fields: r.fields })) };
  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_create`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Batch create records', DOMAIN);
  return { records: data.data?.records, reply: `${records.length} 条记录已创建` };
}

async function batchUpdateRecords(args, token) {
  requireTableId(args);
  const records = requireArray(args, 'records', '数组，每项形如 {record_id, fields}');
  records.forEach((r, i) => {
    if (!r || typeof r !== 'object') {
      throw new FeishuError('invalid_param', `records[${i}] 必须是对象`, { param: `records[${i}]` });
    }
    if (!r.record_id) {
      throw new FeishuError('missing_param', `records[${i}].record_id 必填`, { param: `records[${i}].record_id` });
    }
    if (!r.fields || typeof r.fields !== 'object' || Array.isArray(r.fields)) {
      throw new FeishuError('invalid_param', `records[${i}].fields 必须是对象`, { param: `records[${i}].fields` });
    }
  });
  const body = { records };
  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_update`,
    token,
    { body, query: { user_id_type: 'open_id' } },
  );
  checkApi(data, 'Batch update records', DOMAIN);
  return { records: data.data?.records, reply: `${records.length} 条记录已更新` };
}

async function batchDeleteRecords(args, token) {
  requireTableId(args);
  const ids = requireArray(args, 'record_ids', 'record_id 字符串数组');
  const body = { records: ids };
  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/records/batch_delete`,
    token,
    { body },
  );
  checkApi(data, 'Batch delete records', DOMAIN);
  return { success: true, reply: `${ids.length} 条记录已删除` };
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

async function createView(args, token) {
  requireTableId(args);
  requireParam(args, 'name', '视图名称');
  requireParam(args, 'view_type', '视图类型：grid / kanban / gantt / form / calendar / gallery');
  const body = { view_name: args.name, view_type: args.view_type };
  const data = await apiCall(
    'POST',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views`,
    token,
    { body },
  );
  checkApi(data, 'Create view', DOMAIN);
  return { view: data.data?.view, reply: `视图「${args.name}」已创建` };
}

async function listViews(args, token) {
  requireTableId(args);
  const query = {};
  if (args.page_size !== undefined) query.page_size = String(args.page_size);
  if (args.page_token) query.page_token = args.page_token;
  const data = await apiCall('GET', `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views`, token, { query });
  checkApi(data, 'List views', DOMAIN);
  return { views: data.data?.items || [], has_more: data.data?.has_more, page_token: data.data?.page_token };
}

async function getView(args, token) {
  requireTableId(args);
  requireParam(args, 'view_id');
  const data = await apiCall(
    'GET',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`,
    token,
  );
  checkApi(data, 'Get view', DOMAIN);
  return { view: data.data?.view };
}

async function updateView(args, token) {
  requireTableId(args);
  requireParam(args, 'view_id');
  if (args.name === undefined && args.property === undefined) {
    throw new FeishuError('missing_param', 'name 或 property 至少传一个（想更新什么）', { params: ['name', 'property'] });
  }
  const body = {};
  if (args.name !== undefined) body.view_name = args.name;
  if (args.property !== undefined) body.property = args.property;
  const data = await apiCall(
    'PATCH',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`,
    token,
    { body },
  );
  checkApi(data, 'Update view', DOMAIN);
  return { view: data.data?.view, reply: '视图已更新' };
}

async function deleteView(args, token) {
  requireTableId(args);
  requireParam(args, 'view_id');
  const data = await apiCall(
    'DELETE',
    `/bitable/v1/apps/${args.app_token}/tables/${args.table_id}/views/${args.view_id}`,
    token,
  );
  checkApi(data, 'Delete view', DOMAIN);
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
