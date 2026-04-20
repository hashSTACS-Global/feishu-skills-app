/**
 * tools/lib/search-doc.mjs — Feishu search across docs + wiki + drive.
 *
 * Actions: all / docs / wiki_spaces / list_wiki_spaces / wiki_nodes / drive.
 *
 * Contract:
 *   - case_sensitive matching (default true; pass case_sensitive=false for loose match).
 *   - wiki-tree deep search is bounded by max_visits; when hit, truncated=true.
 *   - Auto-pagination on multi-page list endpoints bounded by max_pages (default 20).
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'search-doc' };

const VALID_ACTIONS = ['all', 'docs', 'wiki_spaces', 'list_wiki_spaces', 'wiki_nodes', 'drive'];

function titleMatches(query, title, caseSensitive) {
  if (!query) return true;
  if (caseSensitive) return String(title || '').includes(query);
  return String(title || '').toLowerCase().includes(query.toLowerCase());
}

function docTypeToUrl(docsType, token) {
  if (!token) return '';
  const t = (docsType || '').toLowerCase();
  if (t === 'docx') return `https://www.feishu.cn/docx/${token}`;
  if (t === 'doc') return `https://www.feishu.cn/docs/${token}`;
  if (t === 'sheet') return `https://www.feishu.cn/sheets/${token}`;
  if (t === 'slides') return `https://www.feishu.cn/slides/${token}`;
  if (t === 'bitable') return `https://www.feishu.cn/base/${token}`;
  if (t === 'mindnote') return `https://www.feishu.cn/mindnotes/${token}`;
  if (t === 'file') return `https://www.feishu.cn/file/${token}`;
  return `https://www.feishu.cn/docx/${token}`;
}

function requireCount(args) {
  if (args.count === undefined || args.count === null) return 20;
  if (!Number.isInteger(args.count) || args.count < 1 || args.count > 50) {
    throw new FeishuError('invalid_param', 'count 必须是 1-50 的整数', { param: 'count' });
  }
  return args.count;
}

function requireMaxPages(args, dflt) {
  if (args.max_pages === undefined || args.max_pages === null) return dflt;
  if (!Number.isInteger(args.max_pages) || args.max_pages < 1) {
    throw new FeishuError('invalid_param', 'max_pages 必须是正整数', { param: 'max_pages' });
  }
  return args.max_pages;
}

function requireMaxVisits(args, dflt) {
  if (args.max_visits === undefined || args.max_visits === null) return dflt;
  if (!Number.isInteger(args.max_visits) || args.max_visits < 1 || args.max_visits > 500) {
    throw new FeishuError('invalid_param', 'max_visits 必须是 1-500 的整数', { param: 'max_visits' });
  }
  return args.max_visits;
}

// ---------------------------------------------------------------------------
// Low-level fetchers
// ---------------------------------------------------------------------------

async function searchDocsObjects(token, searchKey, count, offset) {
  const data = await apiCall('POST', '/suite/docs-api/search/object', token, {
    body: { search_key: searchKey, count, offset },
  });
  checkApi(data, 'Docs search', DOMAIN);
  const entities = data.data?.docs_entities || [];
  return {
    items: entities.map((e) => ({
      kind: 'doc',
      docs_token: e.docs_token,
      docs_type: e.docs_type,
      title: e.title,
      owner_id: e.owner_id,
      url: docTypeToUrl(e.docs_type, e.docs_token),
    })),
    has_more: !!data.data?.has_more,
    total: data.data?.total ?? entities.length,
  };
}

async function searchDocsPages(token, searchKey, count, offsetStart, maxPages) {
  const items = [];
  let offset = offsetStart;
  let pages = 0;
  let hasMore = true;
  let truncated = false;
  while (hasMore) {
    if (pages >= maxPages) { truncated = true; break; }
    const take = Math.min(50, count);
    const batch = await searchDocsObjects(token, searchKey, take, offset);
    items.push(...batch.items);
    hasMore = batch.has_more;
    offset += take;
    pages += 1;
    if (!batch.items.length) break;
  }
  return { items, pages, truncated };
}

async function listAllWikiSpaces(token, maxPages) {
  const spaces = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    if (pages >= maxPages) { truncated = true; break; }
    const query = { page_size: '50' };
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall('GET', '/wiki/v2/spaces', token, { query });
    checkApi(data, 'List wiki spaces', DOMAIN);
    for (const s of data.data?.items || []) {
      spaces.push({
        kind: 'wiki_space',
        space_id: s.space_id,
        name: s.name,
        description: s.description,
        space_type: s.space_type,
      });
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
    pages += 1;
  } while (pageToken);
  return { spaces, truncated };
}

async function listWikiNodesLevel(token, spaceId, parentNodeToken, maxPages) {
  const items = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    if (pages >= maxPages) { truncated = true; break; }
    const query = { page_size: '50' };
    if (parentNodeToken) query.parent_node_token = parentNodeToken;
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall('GET', `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, token, { query });
    checkApi(data, 'List wiki nodes', DOMAIN);
    for (const n of data.data?.items || []) {
      items.push({
        kind: 'wiki_node',
        space_id: n.space_id,
        node_token: n.node_token,
        obj_token: n.obj_token,
        obj_type: n.obj_type,
        title: n.title,
        parent_node_token: n.parent_node_token,
        has_child: n.has_child,
        wiki_url: n.node_token ? `https://www.feishu.cn/wiki/${n.node_token}` : '',
      });
    }
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
    pages += 1;
  } while (pageToken);
  return { items, truncated };
}

async function searchWikiNodesDeep(token, spaceId, queryText, rootParentToken, maxVisits, caseSensitive) {
  const matches = [];
  const queue = [rootParentToken || ''];
  let visits = 0;
  let truncated = false;
  while (queue.length > 0) {
    if (visits >= maxVisits) { truncated = true; break; }
    const parent = queue.shift();
    let pageToken;
    do {
      if (visits >= maxVisits) { truncated = true; break; }
      const q = { page_size: '50' };
      if (parent) q.parent_node_token = parent;
      if (pageToken) q.page_token = pageToken;
      const data = await apiCall('GET', `/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, token, { query: q });
      checkApi(data, 'List wiki nodes (deep)', DOMAIN);
      visits += 1;
      for (const n of data.data?.items || []) {
        if (titleMatches(queryText, n.title, caseSensitive)) {
          matches.push({
            kind: 'wiki_node',
            space_id: n.space_id,
            node_token: n.node_token,
            obj_token: n.obj_token,
            obj_type: n.obj_type,
            title: n.title,
            parent_node_token: n.parent_node_token,
            has_child: n.has_child,
            wiki_url: n.node_token ? `https://www.feishu.cn/wiki/${n.node_token}` : '',
          });
        }
        if (n.has_child && n.node_token) queue.push(n.node_token);
      }
      pageToken = data.data?.has_more ? data.data.page_token : undefined;
    } while (pageToken);
  }
  return { matches, visits, truncated };
}

async function listDriveFolderAll(token, folderToken, maxPages) {
  const items = [];
  let pageToken;
  let pages = 0;
  let truncated = false;
  do {
    if (pages >= maxPages) { truncated = true; break; }
    const query = { page_size: '200' };
    if (folderToken) query.folder_token = folderToken;
    if (pageToken) query.page_token = pageToken;
    const data = await apiCall('GET', '/drive/v1/files', token, { query });
    checkApi(data, 'List drive folder', DOMAIN);
    items.push(...(data.data?.files || data.data?.items || []));
    pageToken = data.data?.has_more ? data.data.page_token : undefined;
    pages += 1;
  } while (pageToken);
  return { items, truncated };
}

function driveItemToHit(it) {
  const t = (it.type || '').toLowerCase();
  const token = it.token;
  let url = it.url || '';
  if (!url && token) {
    url = t === 'folder' ? `https://www.feishu.cn/drive/folder/${token}` : `https://www.feishu.cn/file/${token}`;
  }
  return {
    kind: 'drive',
    type: it.type,
    token,
    name: it.name,
    parent_token: it.parent_token,
    url,
  };
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function getCaseSensitive(args) {
  if (args.case_sensitive === undefined) return true;
  if (typeof args.case_sensitive !== 'boolean') {
    throw new FeishuError('invalid_param', 'case_sensitive 必须是 boolean', { param: 'case_sensitive' });
  }
  return args.case_sensitive;
}

function requireQuery(args) {
  requireParam(args, 'query', '关键字');
  return args.query;
}

export async function docs(args, token) {
  const query = requireQuery(args);
  const count = requireCount(args);
  const offset = args.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FeishuError('invalid_param', 'offset 必须是非负整数', { param: 'offset' });
  }
  const batch = await searchDocsObjects(token, query, count, offset);
  return {
    action: 'docs',
    query,
    docs: batch.items,
    has_more: batch.has_more,
    total: batch.total,
    reply: `云文档搜索「${query}」：本页 ${batch.items.length} 条`,
  };
}

export async function wiki_spaces(args, token) {
  const query = requireQuery(args);
  const caseSensitive = getCaseSensitive(args);
  const maxPages = requireMaxPages(args, 20);
  const { spaces, truncated } = await listAllWikiSpaces(token, maxPages);
  const matched = spaces.filter((s) => titleMatches(query, s.name, caseSensitive));
  return {
    action: 'wiki_spaces',
    query,
    wiki_spaces: matched,
    total_scanned: spaces.length,
    truncated,
    reply: `知识库空间 ${matched.length}/${spaces.length} 命中「${query}」${truncated ? '（扫描已截断）' : ''}`,
  };
}

export async function list_wiki_spaces(args, token) {
  const maxPages = requireMaxPages(args, 20);
  const { spaces, truncated } = await listAllWikiSpaces(token, maxPages);
  return {
    action: 'list_wiki_spaces',
    wiki_spaces: spaces,
    truncated,
    reply: `共 ${spaces.length} 个知识库空间${truncated ? '（扫描已截断）' : ''}`,
  };
}

export async function wiki_nodes(args, token) {
  requireParam(args, 'wiki_space_id', '用 list_wiki_spaces 先拿到 space_id');
  const query = requireQuery(args);
  const caseSensitive = getCaseSensitive(args);
  const deep = args.deep === true;

  if (deep) {
    const maxVisits = requireMaxVisits(args, 80);
    const { matches, visits, truncated } = await searchWikiNodesDeep(
      token,
      args.wiki_space_id,
      query,
      args.parent_node_token || '',
      maxVisits,
      caseSensitive,
    );
    return {
      action: 'wiki_nodes',
      query,
      wiki_nodes: matches,
      visits,
      max_visits: maxVisits,
      truncated,
      deep: true,
      reply: `知识库深搜「${query}」命中 ${matches.length} 个节点${truncated ? `（遍历已达 max_visits=${maxVisits}）` : ''}`,
    };
  }

  const maxPages = requireMaxPages(args, 20);
  const { items, truncated } = await listWikiNodesLevel(
    token,
    args.wiki_space_id,
    args.parent_node_token || '',
    maxPages,
  );
  const matched = items.filter((n) => titleMatches(query, n.title, caseSensitive));
  return {
    action: 'wiki_nodes',
    query,
    wiki_nodes: matched,
    total_scanned: items.length,
    truncated,
    deep: false,
    reply: `知识库节点（同级）${matched.length}/${items.length} 命中「${query}」${truncated ? '（分页已截断）' : ''}`,
  };
}

export async function drive(args, token) {
  const query = requireQuery(args);
  const caseSensitive = getCaseSensitive(args);
  const folderToken = args.folder_token || '';
  if (folderToken && /^file_/.test(folderToken)) {
    throw new FeishuError(
      'invalid_folder_token_im_file_key',
      '传入的是 IM 消息 file_key（"file_" 开头），不是云盘 folder_token',
      { param: 'folder_token', hint: '先把附件压缩为 zip 或上传云盘获得 folder_token' },
    );
  }
  const maxPages = requireMaxPages(args, 20);
  const { items, truncated } = await listDriveFolderAll(token, folderToken, maxPages);
  const matched = items
    .filter((it) => titleMatches(query, it.name, caseSensitive))
    .map(driveItemToHit);
  return {
    action: 'drive',
    query,
    drive: matched,
    total_scanned: items.length,
    truncated,
    drive_scope: folderToken
      ? { kind: 'folder', folder_token: folderToken }
      : {
          kind: 'root',
          warning: '⚠️ 当前为云盘根目录，不是任何具体文件夹。',
        },
    reply: `云盘搜索「${query}」：命中 ${matched.length}/${items.length}${truncated ? '（扫描已截断）' : ''}`,
  };
}

export async function all(args, token) {
  const query = requireQuery(args);
  const caseSensitive = getCaseSensitive(args);
  const maxPages = requireMaxPages(args, 20);
  const [docsRes, spacesRes] = await Promise.all([
    searchDocsPages(token, query, args.count ?? 50, args.offset ?? 0, maxPages),
    listAllWikiSpaces(token, maxPages),
  ]);
  const payload = {
    action: 'all',
    query,
    docs: docsRes.items,
    docs_truncated: docsRes.truncated,
    wiki_spaces: spacesRes.spaces.filter((s) => titleMatches(query, s.name, caseSensitive)),
    wiki_spaces_truncated: spacesRes.truncated,
  };

  if (args.include_drive === true) {
    const folderToken = args.folder_token || '';
    if (folderToken && /^file_/.test(folderToken)) {
      throw new FeishuError('invalid_folder_token_im_file_key', '传入的是 IM file_key', { param: 'folder_token' });
    }
    const driveRes = await listDriveFolderAll(token, folderToken, maxPages);
    payload.drive = driveRes.items
      .filter((it) => titleMatches(query, it.name, caseSensitive))
      .map(driveItemToHit);
    payload.drive_truncated = driveRes.truncated;
  }

  const parts = [];
  if (payload.docs?.length) parts.push(`云文档 ${payload.docs.length} 条`);
  if (payload.wiki_spaces?.length) parts.push(`知识库空间 ${payload.wiki_spaces.length} 个`);
  if (payload.drive?.length) parts.push(`云盘 ${payload.drive.length} 项`);
  payload.reply = parts.length
    ? `搜索「${query}」：${parts.join('；')}`
    : `未找到与「${query}」匹配的结果`;
  return payload;
}

export const ACTIONS = {
  all,
  docs,
  wiki_spaces,
  list_wiki_spaces,
  wiki_nodes,
  drive,
};

export { FeishuError };

if (false) { void VALID_ACTIONS; } // reserved, tree-shake-safe
