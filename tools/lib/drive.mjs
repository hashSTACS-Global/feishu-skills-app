/**
 * tools/lib/drive.mjs — Feishu Drive operations (pure async functions).
 * Refactored from legacy feishu-drive/drive.mjs (now removed; history in git).
 *
 * Removed: CLI parsing, sendCard side-effects, process.exit.
 * Added: structured error throws (FeishuError) with code + required_scopes.
 * Kept: business logic (API calls, multipart upload, etc.) verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';

class FeishuError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

const DOC_TYPES = new Set([
  'doc', 'sheet', 'file', 'bitable', 'docx', 'folder', 'mindnote', 'slides',
]);

const DOC_TYPE_URL_PREFIX = {
  folder: 'drive/folder', docx: 'docx', doc: 'docs',
  sheet: 'sheets', bitable: 'base', mindnote: 'mindnotes',
  slides: 'slides', file: 'file',
};

const UPLOAD_ALL_LIMIT = 15 * 1024 * 1024;

export function buildFeishuUrl(token, type) {
  if (!token) return '';
  const prefix = DOC_TYPE_URL_PREFIX[type];
  if (!prefix) return '';
  return `https://www.feishu.cn/${prefix}/${token}`;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function apiCall(method, urlPath, token, { body, query } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try { data = await res.json(); } catch (e) {
    throw new FeishuError('api_error', `Feishu API parse error: ${res.status} ${res.statusText}`);
  }
  return data;
}

async function apiCallRaw(method, urlPath, token, { body, query, headers } = {}) {
  let url = `https://open.feishu.cn/open-apis${urlPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams(query).toString();
    url += (url.includes('?') ? '&' : '?') + qs;
  }
  return fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(headers || {}) },
    body,
  });
}

function checkApiResult(data, opName) {
  if (data.code === 0) return data;
  const msg = `${opName} failed: code=${data.code} msg=${data.msg}`;
  if (data.code === 99991663) throw new FeishuError('auth_required', '飞书 token 已失效，请重新授权');
  if (data.code === 99991400) throw new FeishuError('rate_limited', msg);
  if (data.code === 99991672 || data.code === 99991679 || /permission|scope|not support|tenant/i.test(data.msg || '')) {
    throw new FeishuError('permission_required', msg, {
      required_scopes: ['drive:drive', 'drive:drive:readonly'],
      reply: '⚠️ 权限不足，需要重新授权以获取访问云盘的权限',
    });
  }
  throw new FeishuError('api_error', msg);
}

// ---------------------------------------------------------------------------
// Action: list
// ---------------------------------------------------------------------------

export async function listFolder(accessToken, args = {}) {
  const folderToken = args.folder_token || '';
  if (folderToken && /^file_/.test(folderToken)) {
    throw new FeishuError('invalid_folder_token_im_file_key',
      '传入的是 IM 消息 file_key（以 file_ 开头），不是云盘 folder_token。',
      { hint: '引导用户：① 本地把文件夹压缩为 .zip 后发送；或 ② 上传云盘后分享 /drive/folder/<token> 链接。' });
  }

  const items = [];
  let pageToken;
  do {
    const query = { page_size: '200' };
    if (folderToken) query.folder_token = folderToken;
    if (pageToken) query.page_token = pageToken;

    const data = await apiCall('GET', '/drive/v1/files', accessToken, { query });
    checkApiResult(data, 'List folder');
    const list = data.data?.files || data.data?.items || [];
    for (const it of list) {
      items.push({ token: it.token, name: it.name, type: it.type, parent_token: it.parent_token, url: it.url });
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);

  const scope = folderToken
    ? { kind: 'folder', folder_token: folderToken }
    : { kind: 'root', warning: '⚠️ 当前为云盘根目录，不是任何具体文件夹。若用户本意查某个文件夹但未提供 folder_token，不要把此结果当作"该文件夹的内容"回复用户。' };

  return {
    action: 'list',
    folder_token: folderToken,
    scope,
    count: items.length,
    items,
    reply: folderToken
      ? `当前文件夹下共有 ${items.length} 个项目。`
      : `云盘根目录下共有 ${items.length} 个项目（这是根目录，不是某个具体文件夹）。`,
  };
}

// ---------------------------------------------------------------------------
// Action: create_folder
// ---------------------------------------------------------------------------

export async function createFolder(accessToken, args = {}) {
  const { name, folder_token: parentFolderToken } = args;
  if (!name) throw new FeishuError('missing_param', 'name 必填（新建文件夹名称）');

  const data = await apiCall('POST', '/drive/v1/files/create_folder', accessToken, {
    body: { name, folder_token: parentFolderToken || '' },
  });
  checkApiResult(data, 'Create folder');
  const result = data.data;
  const token = result?.token;
  const url = result?.url || buildFeishuUrl(token, 'folder');

  return {
    action: 'create_folder',
    folder_token: token,
    url,
    name,
    parent_folder_token: parentFolderToken || '',
    reply: url
      ? `已在目标目录下创建文件夹「${name}」。\n📁 链接：${url}`
      : `已在目标目录下创建文件夹「${name}」。`,
  };
}

// ---------------------------------------------------------------------------
// Action: get_meta
// ---------------------------------------------------------------------------

function parseRequestDocs(input) {
  if (!input) throw new FeishuError('missing_param', 'request_docs 必填，格式如 token1:docx,token2:sheet 或数组');
  const parts = typeof input === 'string'
    ? input.split(',').map(s => s.trim()).filter(Boolean)
    : Array.isArray(input)
      ? input.map(o => typeof o === 'string' ? o : `${o.doc_token}:${o.doc_type}`)
      : [];
  if (!parts.length) throw new FeishuError('missing_param', 'request_docs 不能为空');
  if (parts.length > 50) throw new FeishuError('invalid_param', 'request_docs 最多 50 条');
  return parts.map((part) => {
    const [docToken, docType] = part.split(':').map(s => (s || '').trim());
    if (!docToken || !docType) throw new FeishuError('invalid_param', `request_docs 项格式错误: ${part}，应为 token:type`);
    if (!DOC_TYPES.has(docType)) throw new FeishuError('invalid_param', `不支持的 doc_type: ${docType}`);
    return { doc_token: docToken, doc_type: docType };
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
  const requestDocs = parseRequestDocs(args.request_docs);
  const data = await apiCall('POST', '/drive/v1/metas/batch_query', accessToken, {
    body: { request_docs: requestDocs },
  });
  checkApiResult(data, 'Get meta');
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
  const { file_token: fileToken, name, type, folder_token: folderToken } = args;
  if (!fileToken) throw new FeishuError('missing_param', 'file_token 必填（待复制文件 token）');
  if (!name) throw new FeishuError('missing_param', 'name 必填（副本名称）');
  if (!type) throw new FeishuError('missing_param', 'type 必填（文档类型）');
  if (!DOC_TYPES.has(type)) throw new FeishuError('invalid_param', `type 不支持：${type}`);
  if (fileToken && /^file_/.test(fileToken)) {
    throw new FeishuError('invalid_file_token_im_file_key', '传入的是 IM file_key，不是云盘 file_token');
  }

  const data = await apiCall('POST', `/drive/v1/files/${encodeURIComponent(fileToken)}/copy`, accessToken, {
    body: { name, type, folder_token: folderToken || '' },
  });
  checkApiResult(data, 'Copy file');
  const file = data.data?.file;
  const copyUrl = file?.url || buildFeishuUrl(file?.token, type);
  const copyToken = file?.token ?? file?.file_token ?? '';
  const copySummary = `复制成功 | name=${file?.name || name} | token=${copyToken} | type=${type}${copyUrl ? ` | url=${copyUrl}` : ''}`;
  return {
    action: 'copy',
    file,
    url: copyUrl,
    reply: copyUrl ? `${copySummary}\n副本链接：[${file?.name || name}](${copyUrl})` : copySummary,
  };
}

// ---------------------------------------------------------------------------
// Action: move
// ---------------------------------------------------------------------------

export async function moveFile(accessToken, args = {}) {
  const { file_token: fileToken, type, folder_token: folderToken } = args;
  if (!fileToken) throw new FeishuError('missing_param', 'file_token 必填（待移动文件 token）');
  if (!type) throw new FeishuError('missing_param', 'type 必填（文档类型）');
  if (!DOC_TYPES.has(type)) throw new FeishuError('invalid_param', `type 不支持：${type}`);
  if (!folderToken) throw new FeishuError('missing_param', 'folder_token 必填（目标文件夹 token）');

  const data = await apiCall('POST', `/drive/v1/files/${encodeURIComponent(fileToken)}/move`, accessToken, {
    body: { type, folder_token: folderToken },
  });
  checkApiResult(data, 'Move file');
  const result = data.data || {};
  const moveSummary = `移动已提交 | file_token=${fileToken} | type=${type} | 目标folder_token=${folderToken}${result.task_id ? ` | task_id=${result.task_id}` : ''}`;
  return {
    action: 'move',
    task_id: result.task_id || null,
    target_folder_token: folderToken,
    data: result,
    reply: result.task_id ? `${moveSummary}（异步任务，请稍后在目标文件夹中确认）` : moveSummary,
  };
}

// ---------------------------------------------------------------------------
// Action: delete (requires confirm_delete: true)
// ---------------------------------------------------------------------------

export async function deleteFile(accessToken, args = {}) {
  const { file_token: fileToken, type, confirm_delete: confirmDelete } = args;
  if (!fileToken) throw new FeishuError('missing_param', 'file_token 必填（待删除文件 token）');
  if (!type) throw new FeishuError('missing_param', 'type 必填（文档类型）');
  if (!DOC_TYPES.has(type)) throw new FeishuError('invalid_param', `type 不支持：${type}`);
  if (!confirmDelete) {
    throw new FeishuError('confirmation_required',
      '删除前必须先执行 get_meta，向用户展示文件名、类型与 token，待用户明确确认后再追加 confirm_delete=true 执行删除。',
      { hint: '在 input 中加 "confirm_delete": true 后重试' });
  }

  const data = await apiCall('DELETE', `/drive/v1/files/${encodeURIComponent(fileToken)}`, accessToken, {
    query: { type },
  });
  checkApiResult(data, 'Delete file');
  const result = data.data || {};
  const delSummary = `删除已提交 | file_token=${fileToken} | type=${type}${result.task_id ? ` | task_id=${result.task_id}` : ''}`;
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
  const { file_path: filePath, file_base64: fileBase64, file_name: fileName } = args;
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new FeishuError('file_not_found', `文件不存在: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new FeishuError('invalid_param', `不是有效文件: ${resolved}`);
    return { fileName: path.basename(resolved), buffer: fs.readFileSync(resolved), source: 'file_path', sourcePath: resolved };
  }
  if (fileBase64) {
    if (!fileName) throw new FeishuError('missing_param', '使用 file_base64 时必须提供 file_name');
    return { fileName, buffer: Buffer.from(fileBase64, 'base64'), source: 'file_base64' };
  }
  throw new FeishuError('missing_param', '上传必须提供 file_path 或 file_base64');
}

async function uploadAll(accessToken, fileName, buffer, folderToken) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'explorer');
  form.append('parent_node', folderToken || '');
  form.append('size', String(buffer.length));
  form.append('file', new Blob([buffer]), fileName);
  const res = await apiCallRaw('POST', '/drive/v1/files/upload_all', accessToken, { body: form });
  const data = await res.json();
  checkApiResult(data, 'Upload all');
  const d = data.data || {};
  return { file_token: d.file_token || d.file?.token || d.file?.file_token || null, file_name: d.file?.name || fileName, size: buffer.length, data: d };
}

async function uploadPrepare(accessToken, fileName, size, folderToken) {
  const data = await apiCall('POST', '/drive/v1/files/upload_prepare', accessToken, {
    body: { file_name: fileName, parent_type: 'explorer', parent_node: folderToken || '', size },
  });
  checkApiResult(data, 'Upload prepare');
  return data.data || {};
}

async function uploadPart(accessToken, uploadId, seq, chunkBuffer) {
  const form = new FormData();
  form.append('upload_id', uploadId);
  form.append('seq', String(seq));
  form.append('size', String(chunkBuffer.length));
  form.append('file', new Blob([chunkBuffer]), `part-${seq}`);
  const res = await apiCallRaw('POST', '/drive/v1/files/upload_part', accessToken, { body: form });
  const data = await res.json();
  if (data.code !== 0) throw new FeishuError('api_error', `Upload part failed: seq=${seq} code=${data.code} msg=${data.msg}`);
}

async function uploadFinish(accessToken, uploadId, blockNum) {
  const data = await apiCall('POST', '/drive/v1/files/upload_finish', accessToken, {
    body: { upload_id: uploadId, block_num: blockNum },
  });
  checkApiResult(data, 'Upload finish');
  const d = data.data || {};
  return { file_token: d.file_token || d.file?.token || d.file?.file_token || null, file_name: d.file?.name || null, data: d };
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
    if (!uploadId) throw new FeishuError('api_error', 'Upload prepare 未返回 upload_id');
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
  const res = await apiCallRaw('GET', `/drive/v1/files/${encodeURIComponent(fileToken)}/download`, accessToken);
  if (!res.ok) {
    const txt = await res.text();
    throw new FeishuError('api_error', `Download failed: status=${res.status} body=${txt.slice(0, 300)}`);
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
  const { file_token: fileToken, output_path: outputPath } = args;
  if (!fileToken) throw new FeishuError('missing_param', 'file_token 必填（待下载文件 token）');
  if (fileToken && /^file_/.test(fileToken)) {
    throw new FeishuError('invalid_file_token_im_file_key', '传入的是 IM file_key，不是云盘 file_token');
  }

  const fileBuffer = await downloadFileBuffer(accessToken, fileToken);
  if (outputPath) {
    const savePath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, fileBuffer);
    return { action: 'download', saved_path: savePath, size: fileBuffer.length, reply: `文件已下载到：${savePath}` };
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
