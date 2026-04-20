/**
 * tools/lib/doc-media.mjs — Feishu doc media (insert / download).
 *
 * Contract:
 *   - document_id must be the raw ID (not a URL). Caller extracts it.
 *   - output_path must include a file extension; we do NOT infer from MIME.
 *   - align / type must be explicit (no defaults).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'doc-media' };

const MAX_FILE_SIZE = 20 * 1024 * 1024;

const ALLOWED_READ_DIRS = ['/tmp/', path.join(os.homedir(), '.enclaws', 'tenants')];
const ALLOWED_WRITE_DIRS = ['/tmp/', path.join(os.homedir(), '.enclaws', 'tenants')];

const VALID_MEDIA_TYPES = ['image', 'file'];
const VALID_ALIGN = { left: 1, center: 2, right: 3 };
const VALID_RESOURCE_TYPES = ['media', 'whiteboard'];

function checkPathAllowed(filePath, allowedDirs, paramName) {
  const resolved = path.resolve(filePath);
  const allowed = allowedDirs.some((dir) => resolved.startsWith(path.resolve(dir)));
  if (!allowed) {
    throw new FeishuError(
      'path_not_allowed',
      `${paramName} 路径不在允许范围内: ${filePath}\n允许的目录: ${allowedDirs.join(', ')}`,
      { param: paramName, allowed_dirs: allowedDirs },
    );
  }
}

function resolveDefaultOutputDir() {
  const envWorkspace = process.env.ENCLAWS_USER_WORKSPACE;
  if (envWorkspace) return path.join(envWorkspace, 'download');
  return path.join(process.cwd(), 'download');
}

// ---------------------------------------------------------------------------
// Action: insert
// ---------------------------------------------------------------------------

export async function insert(args, accessToken) {
  requireParam(args, 'document_id', '文档 ID（不要传 URL，请自行提取 /docx/<id>）');
  requireParam(args, 'file_path', '本地文件绝对路径');
  requireParam(args, 'type', 'image / file');
  if (!VALID_MEDIA_TYPES.includes(args.type)) {
    throw new FeishuError('invalid_param', `type 必须是 image / file`, { param: 'type', got: args.type });
  }

  if (args.type === 'image') {
    requireParam(args, 'align', 'left / center / right');
    if (!Object.keys(VALID_ALIGN).includes(args.align)) {
      throw new FeishuError('invalid_param', `align 必须是 left / center / right`, { param: 'align', got: args.align });
    }
  }

  const filePath = path.resolve(args.file_path);
  checkPathAllowed(filePath, ALLOWED_READ_DIRS, 'file_path');
  if (!fs.existsSync(filePath)) {
    throw new FeishuError('file_not_found', `文件不存在：${filePath}`, { param: 'file_path' });
  }
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new FeishuError(
      'file_too_large',
      `文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB 超过 20MB 限制`,
      { param: 'file_path', size: stat.size, max: MAX_FILE_SIZE },
    );
  }
  const fileName = path.basename(filePath);
  const fileSize = stat.size;
  const documentId = args.document_id;

  // Step 1: create empty block at the end of the doc
  const blockType = args.type === 'image' ? 27 : 23;
  const blockData = args.type === 'image' ? { image: {} } : { file: { token: '' } };
  const createData = await apiCall(
    'POST',
    `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
    accessToken,
    {
      query: { document_revision_id: '-1' },
      body: { children: [{ block_type: blockType, ...blockData }] },
    },
  );
  checkApi(createData, 'Create empty media block', DOMAIN);

  const blockId = args.type === 'file'
    ? createData.data?.children?.[0]?.children?.[0]
    : createData.data?.children?.[0]?.block_id;
  if (!blockId) {
    throw new FeishuError('api_error', '未返回 block_id，创建 Block 失败', { document_id: documentId });
  }

  // Step 2: upload media
  const parentType = args.type === 'image' ? 'docx_image' : 'docx_file';
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', parentType);
  form.append('parent_node', blockId);
  form.append('size', String(fileSize));
  form.append('extra', JSON.stringify({ drive_route_token: documentId }));
  form.append('file', new Blob([fs.readFileSync(filePath)]), fileName);

  const uploadData = await apiCall('POST', '/drive/v1/files/upload_all', accessToken, { body: form });
  checkApi(uploadData, 'Upload media', DOMAIN);
  const fileToken = uploadData.data?.file_token;
  if (!fileToken) {
    throw new FeishuError('api_error', '上传素材未返回 file_token');
  }

  // Step 3: patch block with the file_token
  const patchRequest = { block_id: blockId };
  if (args.type === 'image') {
    patchRequest.replace_image = {
      token: fileToken,
      align: VALID_ALIGN[args.align],
      ...(args.caption ? { caption: { content: args.caption } } : {}),
    };
  } else {
    patchRequest.replace_file = { token: fileToken };
  }

  const patchData = await apiCall(
    'PATCH',
    `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/batch_update`,
    accessToken,
    {
      query: { document_revision_id: '-1' },
      body: { requests: [patchRequest] },
    },
  );
  checkApi(patchData, 'Patch media block', DOMAIN);

  const docUrl = `https://www.feishu.cn/docx/${documentId}`;
  return {
    action: 'insert',
    success: true,
    type: args.type,
    document_id: documentId,
    block_id: blockId,
    file_token: fileToken,
    file_name: fileName,
    url: docUrl,
    reply: `已在文档末尾插入${args.type === 'image' ? '图片' : '文件'}「${fileName}」\n文档链接：${docUrl}`,
  };
}

// ---------------------------------------------------------------------------
// Action: download
// ---------------------------------------------------------------------------

export async function download(args, accessToken) {
  requireParam(args, 'resource_token');
  requireParam(args, 'resource_type', `media 或 whiteboard`);
  if (!VALID_RESOURCE_TYPES.includes(args.resource_type)) {
    throw new FeishuError('invalid_param', `resource_type 必须是 media / whiteboard`, { param: 'resource_type', got: args.resource_type });
  }

  requireParam(
    args,
    'output_path',
    '包含完整文件名 + 扩展名的绝对路径（如 /tmp/foo.png）。pipeline 不会按 MIME 猜扩展名',
  );
  const finalPath = path.resolve(args.output_path);
  if (!path.extname(finalPath)) {
    throw new FeishuError(
      'invalid_param',
      `output_path 必须带文件扩展名（如 .png / .pdf），got: ${args.output_path}`,
      { param: 'output_path', got: args.output_path },
    );
  }
  checkPathAllowed(path.dirname(finalPath), ALLOWED_WRITE_DIRS, 'output_path');

  const urlPath = args.resource_type === 'media'
    ? `/drive/v1/medias/${encodeURIComponent(args.resource_token)}/download`
    : `/board/v1/whiteboards/${encodeURIComponent(args.resource_token)}/download_as_image`;

  const res = await apiCall('GET', urlPath, accessToken, { raw: true });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new FeishuError('api_error', `下载失败 HTTP ${res.status}: ${txt.slice(0, 300)}`, { http_status: res.status });
  }

  const contentType = res.headers.get('content-type') || '';
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, buffer);

  return {
    action: 'download',
    resource_type: args.resource_type,
    resource_token: args.resource_token,
    size_bytes: buffer.length,
    content_type: contentType,
    saved_path: finalPath,
    reply: `已下载到 ${finalPath}（${(buffer.length / 1024).toFixed(1)} KB）`,
  };
}

export { resolveDefaultOutputDir };

export const ACTIONS = { insert, download };
export { FeishuError };
