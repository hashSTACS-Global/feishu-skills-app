/**
 * tools/lib/docx-download.mjs — download a file attachment from Drive or Wiki.
 *
 * Single action: download.
 *
 * Contract:
 *   - Caller supplies source_type + token (no URL parsing).
 *   - Caller supplies output_dir and output_name (no filename inference).
 *   - Wiki source resolves wiki_token → obj_token (file). If the resolved node
 *     isn't a file attachment, we throw.
 */

import fs from 'node:fs';
import path from 'node:path';

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'docx-download' };

const VALID_SOURCE_TYPES = ['file', 'wiki'];

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** Resolve a wiki node token to a file obj_token; throw if not a file. */
async function resolveWikiFileToken(wikiToken, accessToken) {
  const data = await apiCall('GET', '/wiki/v2/spaces/get_node', accessToken, {
    query: { token: wikiToken, obj_type: 'wiki' },
  });
  checkApi(data, 'Resolve wiki node', DOMAIN);
  const node = data.data?.node;
  if (!node) {
    throw new FeishuError('wiki_node_not_found', `wiki 节点不存在: ${wikiToken}`, { param: 'token' });
  }
  if (node.obj_type !== 'file') {
    throw new FeishuError(
      'not_a_file_attachment',
      `wiki 节点 ${wikiToken} 是 ${node.obj_type}（非附件），不能作为 file 下载。若是在线文档请用 fetch-doc pipeline`,
      { param: 'token', obj_type: node.obj_type },
    );
  }
  return { obj_token: node.obj_token, title: node.title || '' };
}

export async function download(args, accessToken) {
  requireParam(args, 'source_type', `${VALID_SOURCE_TYPES.join(' / ')}`);
  if (!VALID_SOURCE_TYPES.includes(args.source_type)) {
    throw new FeishuError(
      'invalid_param',
      `source_type 必须是 ${VALID_SOURCE_TYPES.join(' / ')} 之一`,
      { param: 'source_type', got: args.source_type },
    );
  }
  requireParam(args, 'token', 'wiki 节点 token 或 drive file_token');
  requireParam(args, 'output_dir', '下载目录绝对路径');
  requireParam(args, 'output_name', '文件名（含扩展名，如 report.docx）');

  const fileToken = args.source_type === 'wiki'
    ? (await resolveWikiFileToken(args.token, accessToken)).obj_token
    : args.token;

  const res = await apiCall(
    'GET',
    `/drive/v1/files/${encodeURIComponent(fileToken)}/download`,
    accessToken,
    { raw: true },
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new FeishuError(
      'download_error',
      `下载失败 HTTP ${res.status}: ${txt.slice(0, 300)}`,
      { http_status: res.status },
    );
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    // Server returned an error envelope as JSON instead of binary
    const txt = await res.text().catch(() => '');
    throw new FeishuError(
      'download_error',
      `飞书返回 JSON 而非文件内容，疑似错误: ${txt.slice(0, 300)}`,
      { http_status: res.status },
    );
  }

  const outputDir = path.resolve(args.output_dir);
  fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, args.output_name);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outputPath, buffer);
  const size = fs.statSync(outputPath).size;

  return {
    action: 'download',
    success: true,
    file_path: outputPath,
    file_name: args.output_name,
    size_bytes: size,
    content_type: contentType,
    reply: `文件已下载：${args.output_name}（${formatSize(size)}），保存至：${outputPath}`,
  };
}

export const ACTIONS = { download };
export { FeishuError };
