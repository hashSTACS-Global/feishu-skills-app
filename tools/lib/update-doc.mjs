/**
 * tools/lib/update-doc.mjs — update Feishu docx content.
 *
 * Actions: append / overwrite / update_title.
 *
 * Contract:
 *   - doc_id must be a raw token (no URL parsing).
 *   - No silent `mode` default — caller picks the action.
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';
import { markdownToBlocks as buildBlocks } from './create-doc.mjs';

const DOMAIN = { domain: 'update-doc' };

async function getDocChildBlockIds(docId, token) {
  const blocks = [];
  let pageToken;
  do {
    const query = { document_id: docId, page_size: '500' };
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall('GET', `/docx/v1/documents/${encodeURIComponent(docId)}/blocks`, token, { query });
    checkApi(data, 'Fetch blocks', DOMAIN);
    if (data.data?.items) blocks.push(...data.data.items);
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
  } while (pageToken);
  return blocks.filter((b) => b.parent_id === docId && b.block_id !== docId).map((b) => b.block_id);
}

async function appendBlocks(docId, blocks, token) {
  if (!blocks.length) return;
  const BATCH = 50;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    const data = await apiCall(
      'POST',
      `/docx/v1/documents/${encodeURIComponent(docId)}/blocks/${encodeURIComponent(docId)}/children`,
      token,
      { body: { children: batch, index: -1 } },
    );
    checkApi(data, 'Append blocks', DOMAIN);
  }
}

export async function append(args, token) {
  requireParam(args, 'doc_id', '文档 token（不要传 URL）');
  requireParam(args, 'markdown', '要追加的 Markdown 文本');
  const blocks = buildBlocks(args.markdown);
  await appendBlocks(args.doc_id, blocks, token);
  const docUrl = `https://www.feishu.cn/docx/${args.doc_id}`;
  return {
    action: 'append',
    doc_id: args.doc_id,
    doc_url: docUrl,
    reply: `已将内容追加到文档末尾。链接：${docUrl}`,
  };
}

export async function overwrite(args, token) {
  requireParam(args, 'doc_id');
  requireParam(args, 'markdown', '要覆盖写入的 Markdown 文本');
  const childIds = await getDocChildBlockIds(args.doc_id, token);
  if (childIds.length > 0) {
    const data = await apiCall(
      'DELETE',
      `/docx/v1/documents/${encodeURIComponent(args.doc_id)}/blocks/${encodeURIComponent(args.doc_id)}/children/batch_delete`,
      token,
      { body: { start_index: 0, end_index: childIds.length } },
    );
    checkApi(data, 'Delete blocks', DOMAIN);
  }
  const blocks = buildBlocks(args.markdown);
  await appendBlocks(args.doc_id, blocks, token);
  const docUrl = `https://www.feishu.cn/docx/${args.doc_id}`;
  return {
    action: 'overwrite',
    doc_id: args.doc_id,
    doc_url: docUrl,
    reply: `文档内容已覆盖更新。链接：${docUrl}`,
  };
}

export async function update_title(args, token) {
  requireParam(args, 'doc_id');
  requireParam(args, 'title', '新标题');
  const data = await apiCall(
    'PATCH',
    `/docx/v1/documents/${encodeURIComponent(args.doc_id)}`,
    token,
    { body: { title: args.title } },
  );
  checkApi(data, 'Update title', DOMAIN);
  const docUrl = `https://www.feishu.cn/docx/${args.doc_id}`;
  return {
    action: 'update_title',
    doc_id: args.doc_id,
    doc_url: docUrl,
    title: args.title,
    reply: `文档标题已更新为「${args.title}」。链接：${docUrl}`,
  };
}

export const ACTIONS = { append, overwrite, update_title };
export { FeishuError };
