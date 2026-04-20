/**
 * tools/lib/doc-comment.mjs — Feishu doc comments (list / create / patch).
 *
 * Contract:
 *   - is_solved / include_replies must be actual booleans (no string coercion).
 *   - When file_type=wiki, pipeline looks up the real (obj_token, obj_type).
 *     If lookup fails, we throw (no silent fallback).
 *   - Reply expansion is opt-in via include_replies: true.
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'doc-comment' };

const VALID_FILE_TYPES = ['docx', 'doc', 'sheet', 'bitable', 'file', 'slides', 'wiki'];

const DOC_TYPE_URL = {
  docx: (t) => `https://www.feishu.cn/docx/${t}`,
  doc: (t) => `https://www.feishu.cn/docs/${t}`,
  sheet: (t) => `https://www.feishu.cn/sheets/${t}`,
  bitable: (t) => `https://www.feishu.cn/base/${t}`,
  slides: (t) => `https://www.feishu.cn/slides/${t}`,
  file: (t) => `https://www.feishu.cn/file/${t}`,
};

function requireFileType(args) {
  requireParam(args, 'file_type', `支持: ${VALID_FILE_TYPES.join(' / ')}`);
  if (!VALID_FILE_TYPES.includes(args.file_type)) {
    throw new FeishuError(
      'invalid_param',
      `file_type 必须是 ${VALID_FILE_TYPES.join(' / ')} 之一`,
      { param: 'file_type', got: args.file_type },
    );
  }
}

function requireBool(args, key) {
  if (args[key] === undefined || args[key] === null) {
    throw new FeishuError('missing_param', `${key} 必填`, { param: key });
  }
  if (typeof args[key] !== 'boolean') {
    throw new FeishuError(
      'invalid_param',
      `${key} 必须是 boolean（true/false），不接受字符串 "true"/"false"`,
      { param: key, got: typeof args[key] },
    );
  }
  return args[key];
}

async function resolveFileToken(fileToken, fileType, accessToken) {
  if (fileType !== 'wiki') {
    const urlFn = DOC_TYPE_URL[fileType];
    return { fileToken, fileType, docUrl: urlFn ? urlFn(fileToken) : null };
  }
  const data = await apiCall('GET', '/wiki/v2/spaces/get_node', accessToken, {
    query: { token: fileToken, obj_type: 'wiki' },
  });
  checkApi(data, 'Resolve wiki node', DOMAIN);
  const node = data.data?.node;
  if (!node?.obj_token || !node?.obj_type) {
    throw new FeishuError(
      'invalid_param',
      `wiki token "${fileToken}" 无法解析为文档（可能是文件夹节点）`,
      { param: 'file_token', got: fileToken },
    );
  }
  return {
    fileToken: node.obj_token,
    fileType: node.obj_type,
    docUrl: `https://www.feishu.cn/wiki/${fileToken}`,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function list(args, accessToken) {
  requireParam(args, 'file_token');
  requireFileType(args);

  const resolved = await resolveFileToken(args.file_token, args.file_type, accessToken);
  const query = {
    file_type: resolved.fileType,
    user_id_type: 'open_id',
  };
  if (args.page_size !== undefined) {
    if (!Number.isInteger(args.page_size) || args.page_size < 1 || args.page_size > 100) {
      throw new FeishuError('invalid_param', 'page_size 必须是 1-100 的整数', { param: 'page_size' });
    }
    query.page_size = String(args.page_size);
  }
  if (args.page_token) query.page_token = args.page_token;
  if (args.is_whole !== undefined) query.is_whole = args.is_whole;
  if (args.is_solved !== undefined) query.is_solved = args.is_solved;

  const data = await apiCall('GET', `/drive/v1/files/${encodeURIComponent(resolved.fileToken)}/comments`, accessToken, { query });
  checkApi(data, 'List comments', DOMAIN);

  const items = data.data?.items || [];

  if (args.include_replies === true) {
    for (const comment of items) {
      const replies = [];
      let pageToken = null;
      do {
        const rq = { file_type: resolved.fileType, user_id_type: 'open_id', page_size: '50' };
        if (pageToken) rq.page_token = pageToken;
        const rd = await apiCall(
          'GET',
          `/drive/v1/files/${encodeURIComponent(resolved.fileToken)}/comments/${encodeURIComponent(comment.comment_id)}/replies`,
          accessToken,
          { query: rq },
        );
        checkApi(rd, `List replies (comment=${comment.comment_id})`, DOMAIN);
        replies.push(...(rd.data?.items || []));
        pageToken = rd.data?.has_more ? rd.data.page_token : null;
      } while (pageToken);
      comment.reply_list = { replies };
    }
  }

  return {
    action: 'list',
    items,
    has_more: data.data?.has_more || false,
    page_token: data.data?.page_token || null,
    url: resolved.docUrl,
    reply: `找到 ${items.length} 条评论${resolved.docUrl ? `\n文档链接：${resolved.docUrl}` : ''}`,
  };
}

export async function create(args, accessToken) {
  requireParam(args, 'file_token');
  requireFileType(args);
  requireParam(args, 'content', '评论文本');

  const resolved = await resolveFileToken(args.file_token, args.file_type, accessToken);
  const data = await apiCall(
    'POST',
    `/drive/v1/files/${encodeURIComponent(resolved.fileToken)}/comments`,
    accessToken,
    {
      query: { file_type: resolved.fileType, user_id_type: 'open_id' },
      body: {
        reply_list: {
          replies: [{ content: { elements: [{ type: 'text_run', text_run: { text: args.content } }] } }],
        },
      },
    },
  );
  checkApi(data, 'Create comment', DOMAIN);

  const comment = data.data;
  return {
    action: 'create',
    comment,
    comment_id: comment?.comment_id,
    url: resolved.docUrl,
    reply: `评论已创建（comment_id=${comment?.comment_id}）${resolved.docUrl ? `\n文档链接：${resolved.docUrl}` : ''}`,
  };
}

export async function patch(args, accessToken) {
  requireParam(args, 'file_token');
  requireFileType(args);
  requireParam(args, 'comment_id');
  const isSolved = requireBool(args, 'is_solved');

  const resolved = await resolveFileToken(args.file_token, args.file_type, accessToken);
  const data = await apiCall(
    'PATCH',
    `/drive/v1/files/${encodeURIComponent(resolved.fileToken)}/comments/${encodeURIComponent(args.comment_id)}`,
    accessToken,
    {
      query: { file_type: resolved.fileType },
      body: { is_solved: isSolved },
    },
  );
  checkApi(data, 'Patch comment', DOMAIN);

  return {
    action: 'patch',
    success: true,
    url: resolved.docUrl,
    reply: `评论已${isSolved ? '解决' : '恢复'}（comment_id=${args.comment_id}）${resolved.docUrl ? `\n文档链接：${resolved.docUrl}` : ''}`,
  };
}

export const ACTIONS = { list, create, patch };
export { FeishuError };
