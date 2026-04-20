/**
 * tools/lib/sheet.mjs — Feishu Spreadsheet operations.
 *
 * Actions: info / read / write / append / find / create / export.
 *
 * Contract:
 *   - Caller supplies spreadsheet_token (no URL parsing, no wiki auto-resolution).
 *     For wiki-wrapped sheets, caller first resolves via `wiki` pipeline.
 *   - Read enforces MAX_READ_ROWS with explicit `truncated: true` flag.
 *   - Write/append enforce MAX_WRITE_ROWS / MAX_WRITE_COLS.
 *   - For read/write/append/find, caller provides `range` or `sheet_id`
 *     (no silent fallback to "first sheet").
 */

import fs from 'node:fs';
import path from 'node:path';

import { FeishuError, apiCall, checkApi, requireParam, requireOneOf } from './_common.mjs';

const DOMAIN = { domain: 'sheet' };

const MAX_READ_ROWS = 200;
const MAX_WRITE_ROWS = 5000;
const MAX_WRITE_COLS = 100;
const EXPORT_POLL_INTERVAL_MS = 1500;
const EXPORT_POLL_MAX_TRIES = 20;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function colLetter(n) {
  let r = '';
  while (n > 0) { n--; r = String.fromCharCode(65 + (n % 26)) + r; n = Math.floor(n / 26); }
  return r;
}

function flattenCellValue(cell) {
  if (!Array.isArray(cell)) return cell;
  if (cell.length > 0 && cell.every((s) => s != null && typeof s === 'object' && 'text' in s)) {
    return cell.map((s) => s.text).join('');
  }
  return cell;
}

function flattenValues(values) {
  return values ? values.map((row) => row.map(flattenCellValue)) : values;
}

function require2DArray(args, key) {
  const v = args[key];
  if (!Array.isArray(v)) throw new FeishuError('invalid_param', `${key} 必须是二维数组`, { param: key });
  if (v.length === 0) throw new FeishuError('missing_param', `${key} 不能为空`, { param: key });
  v.forEach((row, i) => {
    if (!Array.isArray(row)) throw new FeishuError('invalid_param', `${key}[${i}] 必须是数组`, { param: `${key}[${i}]` });
  });
  return v;
}

function requireRangeOrSheetId(args) {
  if (!args.range && !args.sheet_id) {
    throw new FeishuError(
      'missing_param',
      '需要 range 或 sheet_id 之一（本 pipeline 不会自动 fallback 到"第一个工作表"）',
      { params: ['range', 'sheet_id'] },
    );
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function info(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  const [ssRes, shRes] = await Promise.all([
    apiCall('GET', `/sheets/v3/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}`, accessToken),
    apiCall('GET', `/sheets/v3/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}/sheets/query`, accessToken),
  ]);
  checkApi(ssRes, 'Get spreadsheet', DOMAIN);
  checkApi(shRes, 'Query sheets', DOMAIN);
  const ss = ssRes.data?.spreadsheet;
  const sheets = (shRes.data?.sheets ?? []).map((s) => ({
    sheet_id: s.sheet_id,
    title: s.title,
    index: s.index,
    row_count: s.grid_properties?.row_count,
    column_count: s.grid_properties?.column_count,
  }));
  return {
    action: 'info',
    title: ss?.title,
    spreadsheet_token: args.spreadsheet_token,
    url: `https://www.feishu.cn/sheets/${args.spreadsheet_token}`,
    sheets,
    reply: `电子表格「${ss?.title}」，共 ${sheets.length} 个工作表：${sheets.map((s) => `${s.title}（${s.sheet_id}）`).join('、')}`,
  };
}

export async function read(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  requireRangeOrSheetId(args);
  const valueRenderOption = args.value_render_option ?? 'ToString';

  const range = args.range || args.sheet_id;
  const data = await apiCall(
    'GET',
    `/sheets/v2/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}/values/${encodeURIComponent(range)}`,
    accessToken,
    { query: { valueRenderOption, dateTimeRenderOption: 'FormattedString' } },
  );
  checkApi(data, 'Read range', DOMAIN);

  const vr = data.data?.valueRange;
  let values = flattenValues(vr?.values);
  const totalRows = values ? values.length : 0;
  let truncated = false;
  if (values && values.length > MAX_READ_ROWS) {
    values = values.slice(0, MAX_READ_ROWS);
    truncated = true;
  }
  return {
    action: 'read',
    range: vr?.range,
    values,
    total_rows: totalRows,
    truncated,
    ...(truncated && { hint: `数据超过 ${MAX_READ_ROWS} 行已截断，请缩小 range 后重新读取` }),
    reply: `读取到 ${totalRows} 行${truncated ? `（已截断至 ${MAX_READ_ROWS} 行）` : ''}`,
  };
}

export async function write(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  requireRangeOrSheetId(args);
  const values = require2DArray(args, 'values');
  if (values.length > MAX_WRITE_ROWS) {
    throw new FeishuError('invalid_param', `行数 ${values.length} 超过上限 ${MAX_WRITE_ROWS}`, { param: 'values' });
  }
  if (values.some((r) => r.length > MAX_WRITE_COLS)) {
    throw new FeishuError('invalid_param', `列数超过上限 ${MAX_WRITE_COLS}`, { param: 'values' });
  }

  const range = args.range || args.sheet_id;
  const data = await apiCall(
    'PUT',
    `/sheets/v2/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}/values`,
    accessToken,
    { body: { valueRange: { range, values } } },
  );
  checkApi(data, 'Write range', DOMAIN);
  const d = data.data || {};
  return {
    action: 'write',
    updated_range: d.updatedRange,
    updated_rows: d.updatedRows,
    updated_columns: d.updatedColumns,
    updated_cells: d.updatedCells,
    reply: `已写入 ${d.updatedCells ?? 0} 个单元格（${d.updatedRows ?? 0} 行 × ${d.updatedColumns ?? 0} 列）`,
  };
}

export async function append(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  requireRangeOrSheetId(args);
  const values = require2DArray(args, 'values');
  if (values.length > MAX_WRITE_ROWS) {
    throw new FeishuError('invalid_param', `行数 ${values.length} 超过上限 ${MAX_WRITE_ROWS}`, { param: 'values' });
  }
  const range = args.range || args.sheet_id;
  const data = await apiCall(
    'POST',
    `/sheets/v2/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}/values_append`,
    accessToken,
    { body: { valueRange: { range, values } } },
  );
  checkApi(data, 'Append range', DOMAIN);
  const u = data.data?.updates || {};
  return {
    action: 'append',
    table_range: data.data?.tableRange,
    updated_range: u.updatedRange,
    updated_rows: u.updatedRows,
    updated_columns: u.updatedColumns,
    updated_cells: u.updatedCells,
    reply: `已追加 ${u.updatedRows ?? 0} 行（${u.updatedCells ?? 0} 个单元格）`,
  };
}

export async function find(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  requireParam(args, 'sheet_id');
  requireParam(args, 'find', '搜索内容');

  const findCondition = { range: args.range ? `${args.sheet_id}!${args.range}` : args.sheet_id };
  if (args.match_case !== undefined) findCondition.match_case = !!args.match_case;
  if (args.match_entire_cell !== undefined) findCondition.match_entire_cell = !!args.match_entire_cell;
  if (args.search_by_regex !== undefined) findCondition.search_by_regex = !!args.search_by_regex;
  if (args.include_formulas !== undefined) findCondition.include_formulas = !!args.include_formulas;

  const data = await apiCall(
    'POST',
    `/sheets/v2/spreadsheets/${encodeURIComponent(args.spreadsheet_token)}/sheets/${encodeURIComponent(args.sheet_id)}/find`,
    accessToken,
    { body: { find_condition: findCondition, find: args.find } },
  );
  checkApi(data, 'Find', DOMAIN);
  const fr = data.data?.find_result || {};
  const matched = fr.matched_cells || [];
  return {
    action: 'find',
    matched_cells: matched,
    matched_formula_cells: fr.matched_formula_cells,
    rows_count: fr.rows_count,
    reply: `找到 ${matched.length} 个匹配单元格`,
  };
}

export async function create(args, accessToken) {
  requireParam(args, 'title');
  const body = { title: args.title };
  if (args.folder_token) body.folder_token = args.folder_token;
  const createData = await apiCall('POST', '/sheets/v1/spreadsheets', accessToken, { body });
  checkApi(createData, 'Create spreadsheet', DOMAIN);

  const ss = createData.data?.spreadsheet;
  const token = ss?.spreadsheet_token;
  if (!token) {
    throw new FeishuError('api_error', '创建电子表格失败：未返回 spreadsheet_token');
  }
  const url = `https://www.feishu.cn/sheets/${token}`;

  // Optional initial data population. We require both sheet_id (target) AND data if caller
  // wants to pre-populate. Previous version auto-guessed the first sheet — removed.
  if (args.initial_headers !== undefined || args.initial_data !== undefined) {
    requireParam(args, 'initial_sheet_id', '写入初始数据时需要明确指定 sheet_id');
    const allRows = [];
    if (args.initial_headers !== undefined) {
      if (!Array.isArray(args.initial_headers)) {
        throw new FeishuError('invalid_param', 'initial_headers 必须是数组', { param: 'initial_headers' });
      }
      allRows.push(args.initial_headers);
    }
    if (args.initial_data !== undefined) {
      if (!Array.isArray(args.initial_data)) {
        throw new FeishuError('invalid_param', 'initial_data 必须是二维数组', { param: 'initial_data' });
      }
      args.initial_data.forEach((row, i) => {
        if (!Array.isArray(row)) throw new FeishuError('invalid_param', `initial_data[${i}] 必须是数组`, { param: `initial_data[${i}]` });
        allRows.push(row);
      });
    }
    if (allRows.length > 0) {
      const numCols = Math.max(...allRows.map((r) => r.length));
      const range = `${args.initial_sheet_id}!A1:${colLetter(numCols)}${allRows.length}`;
      const writeData = await apiCall(
        'PUT',
        `/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values`,
        accessToken,
        { body: { valueRange: { range, values: allRows } } },
      );
      checkApi(writeData, 'Create spreadsheet (initial write)', DOMAIN);
    }
  }

  return {
    action: 'create',
    spreadsheet_token: token,
    title: args.title,
    url,
    reply: `已创建电子表格「${args.title}」：${url}`,
  };
}

export async function exportSheet(args, accessToken) {
  requireParam(args, 'spreadsheet_token');
  requireParam(args, 'file_extension', 'xlsx 或 csv');
  if (args.file_extension === 'csv') {
    requireParam(args, 'sheet_id', 'CSV 一次只能导出一个工作表');
  }

  const createData = await apiCall('POST', '/drive/v1/export_tasks', accessToken, {
    body: {
      file_extension: args.file_extension,
      token: args.spreadsheet_token,
      type: 'sheet',
      ...(args.sheet_id && { sub_id: args.sheet_id }),
    },
  });
  checkApi(createData, 'Create export task', DOMAIN);

  const ticket = createData.data?.ticket;
  if (!ticket) {
    throw new FeishuError('api_error', '创建导出任务失败：未返回 ticket');
  }

  let fileToken; let fileName; let fileSize;
  for (let i = 0; i < EXPORT_POLL_MAX_TRIES; i++) {
    await sleep(EXPORT_POLL_INTERVAL_MS);
    const pollData = await apiCall(
      'GET',
      `/drive/v1/export_tasks/${encodeURIComponent(ticket)}`,
      accessToken,
      { query: { token: args.spreadsheet_token } },
    );
    checkApi(pollData, 'Poll export task', DOMAIN);
    const result = pollData.data?.result;
    if (result?.job_status === 0) {
      fileToken = result.file_token;
      fileName = result.file_name;
      fileSize = result.file_size;
      break;
    }
    if (result?.job_status >= 3) {
      throw new FeishuError('export_failed', `导出失败: ${result.job_error_msg || `status=${result.job_status}`}`, { job_status: result.job_status });
    }
  }
  if (!fileToken) {
    throw new FeishuError('export_timeout', `导出超时：任务在 ${(EXPORT_POLL_INTERVAL_MS * EXPORT_POLL_MAX_TRIES) / 1000}秒内未完成`);
  }

  if (args.output_path) {
    const res = await apiCall('GET', `/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, accessToken, { raw: true });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new FeishuError('download_failed', `下载失败: HTTP ${res.status}: ${txt.slice(0, 300)}`, { http_status: res.status });
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const outPath = path.resolve(args.output_path);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, buffer);
    return {
      action: 'export',
      file_path: outPath,
      file_name: fileName,
      file_size: fileSize,
      reply: `已导出并保存到 ${outPath}（${fileName}，${fileSize} 字节）`,
    };
  }

  return {
    action: 'export',
    file_token: fileToken,
    file_name: fileName,
    file_size: fileSize,
    hint: '如需下载到本地，请提供 output_path 参数',
    reply: `导出完成：${fileName}（${fileSize} 字节）`,
  };
}

export const ACTIONS = {
  info,
  read,
  write,
  append,
  find,
  create,
  export: exportSheet,
};

export { FeishuError };
