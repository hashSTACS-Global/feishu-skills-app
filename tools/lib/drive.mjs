/**
 * tools/lib/drive.mjs — Feishu Drive operations (thin API adapter).
 *
 * 8 actions: list / create_folder / get_meta / copy / move / delete / upload / download.
 *
 * Contract:
 *   - Pure pass-through. No auto-pagination. No URL inference.
 *   - Missing / wrong-shape params → throws missing_param / invalid_param.
 *   - Paginated endpoints (list) return one page + has_more + page_token;
 *     caller iterates explicitly.
 */
import fs from 'node:fs';
import path from 'node:path';

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'drive' };

const DOC_TYPES = new Set([
  'doc', 'sheet', 'file', 'bitable', 'docx', 'folder', 'mindnote', 'slides',
]);

const DOC_TYPE_URL_PREFIX = {
  folder: 'drive/folder',
  docx: 'docx',
  doc: 'docs',
  sheet: 'sheets',
  bitable: 'base',
  mindnote: 'mindnotes',
  slides: 'slides',
  file: 'file',
};

const UPLOAD_ALL_LIMIT = 15 * 1024 * 1024;
const LIST_PAGE_SIZE_MAX = 200; // Feishu API upper bound

/**
 * Construct a Feishu front-end URL from a doc token + type.
 * Returns '' if token is empty. Throws invalid_param for unknown types.
 */
export function buildFeishuUrl(token, type) {
  if (!token) return '';
  const prefix = DOC_TYPE_URL_PREFIX[type];
  if (!prefix) {
    throw new FeishuError(
      'invalid_param',
      `buildFeishuUrl: 未知 type=${type}。支持：${Object.keys(DOC_TYPE_URL_PREFIX).join(', ')}`,
      { param: 'type', got: type },
    );
  }
  return `https://www.feishu.cn/${prefix}/${token}`;
}

function requireDocType(args) {
  requireParam(args, 'type', `文档类型，支持 ${[...DOC_TYPES].join(' / ')}`);
  if (!DOC_TYPES.has(args.type)) {
    throw new FeishuError(
      'invalid_param',
      `type 不支持：${args.type}。支持：${[...DOC_TYPES].join(', ')}`,
      { param: 'type', got: args.type },
    );
  }
}

// IM file_key (starts with "file_") is NOT a drive file_token — common LLM mistake.
function rejectImFileKey(token, paramName = 'file_token') {
  if (typeof token === 'string' && /^file_/.test(token)) {
    throw new FeishuError(
      'invalid_im_file_key',
      `${paramName} 看起来是 IM 消息 file_key（"file_" 开头），不是云盘 ${paramName}。`,
      {
        param: paramName,
        hint: '若想操作 IM 里的附件，请先下载到本地或上传到云盘获得真正的 file_token',
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Action: list（单页，不自动翻页）
// ---------------------------------------------------------------------------

export async function listFolder(accessToken, args = {}) {
  const folderToken = args.folder_token || '';
  rejectImFileKey(folderToken, 'folder_token');

  const pageSize = args.page_size;
  if (pageSize !== undefined) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIST_PAGE_SIZE_MAX) {
      throw new FeishuError(
        'invalid_param',
        `page_size 必须是 1-${LIST_PAGE_SIZE_MAX} 的整数`,
        { param: 'page_size' },
      );
    }
  }

  const query = { page_size: String(pageSize ?? LIST_PAGE_SIZE_MAX) };
  if (folderToken) query.folder_token = folderToken;
  if (args.page_token) query.page_token = args.page_token;

  const data = await apiCall('GET', '/drive/v1/files', accessToken, { query });
  checkApi(data, 'List folder', DOMAIN);

  const list = data.data?.files || data.data?.items || [];
  const items = list.map((it) => ({
    token: it.token,
    name: it.name,
    type: it.type,
    parent_token: it.parent_token,
    url: it.url,
  }));
  const hasMore = !!data.data?.has_more;
  const nextPageToken = hasMore ? (data.data?.page_token || null) : null;

  const scope = folderToken
    ? { kind: 'folder', folder_token: folderToken }
    : {
        kind: 'root',
        warning: '⚠️ 当前为云盘根目录，不是任何具体文件夹。若用户本意查某个文件夹但未提供 folder_token，不要把此结果当作"该文件夹的内容"回复用户。',
      };

  return {
    action: 'list',
    folder_token: folderToken,
    scope,
    count: items.length,
    items,
    has_more: hasMore,
    page_token: nextPageToken,
    reply: folderToken
      ? `当前文件夹下本页共 ${items.length} 个项目${hasMore ? '（还有更多，传 page_token 继续翻页）' : '（最后一页）'}。`
      : `云盘根目录本页共 ${items.length} 个项目${hasMore ? '（还有更多）' : ''}。`,
  };
}

// ---------------------------------------------------------------------------
// Action: create_folder
// ---------------------------------------------------------------------------

export async function createFolder(accessToken, args = {}) {
  requireParam(args, 'name', '新建文件夹名称');
  const parentFolderToken = args.folder_token || '';

  const data = await apiCall('POST', '/drive/v1/files/create_folder', accessToken, {
    body: { name: args.name, folder_token: parentFolderToken },
  });
  checkApi(data, 'Create folder', DOMAIN);

  const result = data.data;
  const token = result?.token;
  const url = result?.url || buildFeishuUrl(token, 'folder');

  return {
    action: 'create_folder',
    folder_token: token,
    url,
    name: args.name,
    parent_folder_token: parentFolderToken,
    reply: url
      ? `已在目标目录下创建文件夹「${args.name}」。\n📁 链接：${url}`
      : `已在目标目录下创建文件夹「${args.name}」。`,
  };
}

// ---------------------------------------------------------------------------
// Action: get_meta
// ---------------------------------------------------------------------------

function validateRequestDocs(input) {
  if (input === undefined || input === null) {
    throw new FeishuError(
      'missing_param',
      'request_docs 必填，形如 [{"doc_token":"xxx","doc_type":"docx"}, ...]',
      { param: 'request_docs' },
    );
  }
  if (!Array.isArray(input)) {
    throw new FeishuError(
      'invalid_param',
      'request_docs 必须是数组。形如 [{"doc_token":"xxx","doc_type":"docx"}, ...]',
      { param: 'request_docs', got: typeof input },
    );
  }
  if (input.length === 0) {
    throw new FeishuError('missing_param', 'request_docs 不能为空数组', { param: 'request_docs' });
  }
  if (input.length > 50) {
    throw new FeishuError('invalid_param', 'request_docs 最多 50 条', { param: 'request_docs' });
  }
  return input.map((item, i) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new FeishuError('invalid_param', `request_docs[${i}] 必须是对象 {doc_token, doc_type}`, { param: `request_docs[${i}]` });
    }
    if (!item.doc_token || typeof item.doc_token !== 'string') {
      throw new FeishuError('missing_param', `request_docs[${i}].doc_token 必填`, { param: `request_docs[${i}].doc_token` });
    }
    if (!item.doc_type || !DOC_TYPES.has(item.doc_type)) {
      throw new FeishuError(
        'invalid_param',
        `request_docs[${i}].doc_type 必填且必须是 ${[...DOC_TYPES].join(', ')} 之一`,
        { param: `request_docs[${i}].doc_type`, got: item.doc_type },
      );
    }
    return { doc_token: item.doc_token, doc_type: item.doc_type };
  });
}

function formatMetaSummaryLine(m, index) {
  const title = m.name ?? m.title ?? m.doc_token ?? `第${index + 1}条`;
  const docType = m.type ?? m.doc_type ?? '?';
  const tok = m.doc_token ?? m.token ?? '';
  const owner = m.owner_id ?? m.owner ?? '';
  const created = m.created_time ?? m.create_time ?? '';
  const modified = m.latest_modify_time ?? m.modified_time ?? m.edit_time ?? '';
  const size = m.size != null && m.size !== '' ? m.size : '';
  const parts = [`${index + 1}.「${title}」`, `类型:${docType}`, `token:${tok}`];
  if (owner) parts.push(`创建者/所有者:${owner}`);
  if (created) parts.push(`创建:${created}`);
  if (modified) parts.push(`修改:${modified}`);
  if (size !== '') parts.push(`大小:${size}`);
  return parts.join(' | ');
}

export async function getMeta(accessToken, args = {}) {
  const requestDocs = validateRequestDocs(args.request_docs);
  const data = await apiCall('POST', '/drive/v1/metas/batch_query', accessToken, {
    body: { request_docs: requestDocs },
  });
  checkApi(data, 'Get meta', DOMAIN);
  const metas = data.data?.metas || [];
  const replyText = metas.length
    ? `共 ${metas.length} 条元信息：\n${metas.map((m, i) => formatMetaSummaryLine(m, i)).join('\n')}`
    : '未返回任何文件元信息。';
  return { action: 'get_meta', count: metas.length, metas, reply: replyText };
}

// ---------------------------------------------------------------------------
// Action: copy
// ---------------------------------------------------------------------------

export async function copyFile(accessToken, args = {}) {
  requireParam(args, 'file_token', '待复制文件 token');
  requireParam(args, 'name', '副本名称');
  requireDocType(args);
  rejectImFileKey(args.file_token, 'file_token');

  const folderToken = args.folder_token || '';
  const data = await apiCall(
    'POST',
    `/drive/v1/files/${encodeURIComponent(args.file_token)}/copy`,
    accessToken,
    { body: { name: args.name, type: args.type, folder_token: folderToken } },
  );
  checkApi(data, 'Copy file', DOMAIN);

  const file = data.data?.file;
  const copyUrl = file?.url || buildFeishuUrl(file?.token, args.type);
  const copyToken = file?.token ?? file?.file_token ?? '';
  const copySummary = `复制成功 | name=${file?.name || args.name} | token=${copyToken} | type=${args.type}${copyUrl ? ` | url=${copyUrl}` : ''}`;
  return {
    action: 'copy',
    file,
    url: copyUrl,
    reply: copyUrl ? `${copySummary}\n副本链接：[${file?.name || args.name}](${copyUrl})` : copySummary,
  };
}

// ---------------------------------------------------------------------------
// Action: move
// ---------------------------------------------------------------------------

export async function moveFile(accessToken, args = {}) {
  requireParam(args, 'file_token', '待移动文件 token');
  requireDocType(args);
  requireParam(args, 'folder_token', '目标文件夹 token');
  rejectImFileKey(args.file_token, 'file_token');

  const data = await apiCall(
    'POST',
    `/drive/v1/files/${encodeURIComponent(args.file_token)}/move`,
    accessToken,
    { body: { type: args.type, folder_token: args.folder_token } },
  );
  checkApi(data, 'Move file', DOMAIN);

  const result = data.data || {};
  const moveSummary = `移动已提交 | file_token=${args.file_token} | type=${args.type} | 目标folder_token=${args.folder_token}${result.task_id ? ` | task_id=${result.task_id}` : ''}`;
  return {
    action: 'move',
    task_id: result.task_id || null,
    target_folder_token: args.folder_token,
    data: result,
    reply: result.task_id ? `${moveSummary}（异步任务，请稍后在目标文件夹中确认）` : moveSummary,
  };
}

// ---------------------------------------------------------------------------
// Action: delete (requires confirm_delete: true)
// ---------------------------------------------------------------------------

export async function deleteFile(accessToken, args = {}) {
  requireParam(args, 'file_token', '待删除文件 token');
  requireDocType(args);
  if (args.confirm_delete !== true) {
    throw new FeishuError(
      'confirmation_required',
      '删除前必须先执行 get_meta，向用户展示文件名、类型与 token，待用户明确确认后再追加 confirm_delete=true 执行删除。',
      { hint: '在 input 中加 "confirm_delete": true 后重试' },
    );
  }

  const data = await apiCall(
    'DELETE',
    `/drive/v1/files/${encodeURIComponent(args.file_token)}`,
    accessToken,
    { query: { type: args.type } },
  );
  checkApi(data, 'Delete file', DOMAIN);

  const result = data.data || {};
  const delSummary = `删除已提交 | file_token=${args.file_token} | type=${args.type}${result.task_id ? ` | task_id=${result.task_id}` : ''}`;
  return {
    action: 'delete',
    task_id: result.task_id || null,
    data: result,
    reply: result.task_id ? `${delSummary}（异步任务，删除完成后文件将不可恢复）` : delSummary,
  };
}

// ---------------------------------------------------------------------------
// Action: upload (multipart-aware)
// ---------------------------------------------------------------------------

function loadUploadInput(args) {
  const filePath = args.file_path;
  const fileBase64 = args.file_base64;
  const fileName = args.file_name;

  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new FeishuError('file_not_found', `文件不存在: ${resolved}`, { param: 'file_path' });
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new FeishuError('invalid_param', `不是有效文件: ${resolved}`, { param: 'file_path' });
    }
    return {
      fileName: path.basename(resolved),
      buffer: fs.readFileSync(resolved),
      source: 'file_path',
      sourcePath: resolved,
    };
  }

  if (fileBase64) {
    if (!fileName) {
      throw new FeishuError('missing_param', '使用 file_base64 时必须提供 file_name', { param: 'file_name' });
    }
    return { fileName, buffer: Buffer.from(fileBase64, 'base64'), source: 'file_base64' };
  }

  throw new FeishuError('missing_param', '上传必须提供 file_path 或 file_base64', { params: ['file_path', 'file_base64'] });
}

async function uploadAll(accessToken, fileName, buffer, folderToken) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'explorer');
  form.append('parent_node', folderToken || '');
  form.append('size', String(buffer.length));
  form.append('file', new Blob([buffer]), fileName);
  const data = await apiCall('POST', '/drive/v1/files/upload_all', accessToken, { body: form });
  checkApi(data, 'Upload all', DOMAIN);
  const d = data.data || {};
  return {
    file_token: d.file_token || d.file?.token || d.file?.file_token || null,
    file_name: d.file?.name || fileName,
    size: buffer.length,
    data: d,
  };
}

async function uploadPrepare(accessToken, fileName, size, folderToken) {
  const data = await apiCall('POST', '/drive/v1/files/upload_prepare', accessToken, {
    body: { file_name: fileName, parent_type: 'explorer', parent_node: folderToken || '', size },
  });
  checkApi(data, 'Upload prepare', DOMAIN);
  return data.data || {};
}

async function uploadPart(accessToken, uploadId, seq, chunkBuffer) {
  const form = new FormData();
  form.append('upload_id', uploadId);
  form.append('seq', String(seq));
  form.append('size', String(chunkBuffer.length));
  form.append('file', new Blob([chunkBuffer]), `part-${seq}`);
  const data = await apiCall('POST', '/drive/v1/files/upload_part', accessToken, { body: form });
  if (data.code !== 0) {
    throw new FeishuError('api_error', `Upload part failed: seq=${seq} code=${data.code} msg=${data.msg}`, {
      feishu_code: data.code,
    });
  }
}

async function uploadFinish(accessToken, uploadId, blockNum) {
  const data = await apiCall('POST', '/drive/v1/files/upload_finish', accessToken, {
    body: { upload_id: uploadId, block_num: blockNum },
  });
  checkApi(data, 'Upload finish', DOMAIN);
  const d = data.data || {};
  return {
    file_token: d.file_token || d.file?.token || d.file?.file_token || null,
    file_name: d.file?.name || null,
    data: d,
  };
}

export async function uploadFile(accessToken, args = {}) {
  const input = loadUploadInput(args);
  const folderToken = args.folder_token || '';
  let uploaded;
  if (input.buffer.length <= UPLOAD_ALL_LIMIT) {
    uploaded = { ...(await uploadAll(accessToken, input.fileName, input.buffer, folderToken)), mode: 'upload_all' };
  } else {
    const prepared = await uploadPrepare(accessToken, input.fileName, input.buffer.length, folderToken);
    const uploadId = prepared.upload_id;
    const blockSize = prepared.block_size || UPLOAD_ALL_LIMIT;
    const blockNum = prepared.block_num || Math.ceil(input.buffer.length / blockSize);
    if (!uploadId) {
      throw new FeishuError('api_error', 'Upload prepare 未返回 upload_id');
    }
    for (let seq = 0; seq < blockNum; seq++) {
      const start = seq * blockSize;
      const end = Math.min(start + blockSize, input.buffer.length);
      await uploadPart(accessToken, uploadId, seq, input.buffer.subarray(start, end));
    }
    const finished = await uploadFinish(accessToken, uploadId, blockNum);
    uploaded = { ...finished, mode: 'multipart', file_name: finished.file_name || input.fileName, size: input.buffer.length };
  }

  const url = buildFeishuUrl(uploaded.file_token, 'file');
  const displayName = uploaded.file_name || input.fileName;
  const sz = uploaded.size || input.buffer.length;
  const summary = `上传成功 | file=${displayName} | token=${uploaded.file_token || ''} | size=${sz} bytes | mode=${uploaded.mode}${url ? ` | url=${url}` : ''}`;
  return {
    action: 'upload',
    mode: uploaded.mode,
    file_token: uploaded.file_token,
    file_name: displayName,
    size: sz,
    source: input.source,
    source_path: input.sourcePath || undefined,
    url,
    data: uploaded.data,
    reply: url ? `${summary}\n文件链接：[${displayName}](${url})` : summary,
  };
}

// ---------------------------------------------------------------------------
// Action: download
// ---------------------------------------------------------------------------

async function downloadFileBuffer(accessToken, fileToken) {
  const res = await apiCall(
    'GET',
    `/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
    accessToken,
    { raw: true },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new FeishuError('api_error', `Download failed: status=${res.status} body=${txt.slice(0, 300)}`, {
      http_status: res.status,
    });
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    chunks.push(chunk);
    total += chunk.length;
  }
  return Buffer.concat(chunks, total);
}

export async function download(accessToken, args = {}) {
  requireParam(args, 'file_token', '待下载文件 token');
  rejectImFileKey(args.file_token, 'file_token');

  const fileBuffer = await downloadFileBuffer(accessToken, args.file_token);
  const outputPath = args.output_path;
  if (outputPath) {
    const savePath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, fileBuffer);
    return {
      action: 'download',
      saved_path: savePath,
      size: fileBuffer.length,
      reply: `文件已下载到：${savePath}`,
    };
  }
  return {
    action: 'download',
    file_content_base64: fileBuffer.toString('base64'),
    size: fileBuffer.length,
    reply: `文件下载成功（base64，${fileBuffer.length} bytes）。大文件建议使用 output_path。`,
  };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export const ACTIONS = {
  list: listFolder,
  create_folder: createFolder,
  get_meta: getMeta,
  copy: copyFile,
  move: moveFile,
  delete: deleteFile,
  upload: uploadFile,
  download,
};

export { FeishuError };
