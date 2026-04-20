/**
 * tools/lib/create-doc.mjs — Create a Feishu cloud document (docx) from Markdown.
 *
 * Single action: create.
 *
 * Contract:
 *   - title is required (no default).
 *   - If wiki_node provided and the move fails, we throw — no silent fallback.
 *   - Does NOT send any IM card; caller can invoke im-message pipeline separately.
 *   - markdownToBlocks is a pure data transform (not a smart-fixer).
 */

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';

const DOMAIN = { domain: 'create-doc' };

// ---------------------------------------------------------------------------
// Markdown → Feishu blocks
// ---------------------------------------------------------------------------

const BT = {
  PARAGRAPH: 2,
  H1: 3, H2: 4, H3: 5, H4: 6, H5: 7, H6: 8,
  BULLET: 12,
  ORDERED: 13,
  CODE: 14,
  DIVIDER: 22,
};

const LANG_MAP = {
  'abap': 1, 'ada': 2, 'apache': 3, 'apex': 4, 'apiblueprint': 5,
  'applescript': 6, 'bash': 27, 'sh': 27, 'shell': 27,
  'c': 8, 'cpp': 9, 'c++': 9, 'csharp': 10, 'c#': 10,
  'css': 11, 'coffeescript': 12, 'cmake': 13, 'd': 14,
  'dart': 15, 'delphi': 16, 'dockerfile': 17,
  'elixir': 18, 'elm': 19, 'erlang': 20,
  'fortran': 21, 'fsharp': 22, 'f#': 22,
  'go': 23, 'groovy': 24,
  'html': 25, 'http': 26,
  'java': 28, 'javascript': 29, 'js': 29,
  'json': 30, 'julia': 31, 'kotlin': 32,
  'latex': 33, 'lua': 34,
  'makefile': 35, 'markdown': 36, 'matlab': 37,
  'mermaid': 38, 'nginx': 39, 'objective-c': 40, 'objc': 40,
  'ocaml': 41, 'pascal': 42, 'perl': 43, 'php': 44,
  'powershell': 45, 'prolog': 46, 'protobuf': 47, 'python': 49,
  'r': 50, 'ruby': 51, 'rust': 52, 'scala': 53, 'sql': 56,
  'swift': 57, 'toml': 60, 'tsx': 61, 'typescript': 62, 'ts': 62,
  'vb': 63, 'vbnet': 63, 'verilog': 64,
  'xml': 65, 'yaml': 66, 'yml': 66,
};
const DEFAULT_LANG = 1;

function parseInline(text) {
  const elements = [];
  const re = /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|([^*`]+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) elements.push({ text_run: { content: m[1], text_element_style: { bold: true } } });
    else if (m[2] !== undefined) elements.push({ text_run: { content: m[2], text_element_style: { italic: true } } });
    else if (m[3] !== undefined) elements.push({ text_run: { content: m[3], text_element_style: { inline_code: true } } });
    else if (m[4] !== undefined) elements.push({ text_run: { content: m[4], text_element_style: {} } });
  }
  if (elements.length === 0) elements.push({ text_run: { content: text, text_element_style: {} } });
  return elements;
}

function textBlock(type, keyName, elements) {
  return { block_type: type, [keyName]: { elements, style: {} } };
}
const paragraphBlock = (elements) => textBlock(BT.PARAGRAPH, 'text', elements);
const headingBlock = (level, text) => textBlock(BT.H1 + level - 1, `heading${level}`, parseInline(text));
const bulletBlock = (elements) => textBlock(BT.BULLET, 'bullet', elements);
const orderedBlock = (elements) => textBlock(BT.ORDERED, 'ordered', elements);

function codeBlock(code, lang) {
  return {
    block_type: BT.CODE,
    code: {
      elements: [{ text_run: { content: code } }],
      style: { language: LANG_MAP[(lang || '').toLowerCase()] ?? DEFAULT_LANG, wrap: true },
    },
  };
}
const dividerBlock = () => ({ block_type: BT.DIVIDER, divider: {} });

function markdownToBlocks(md) {
  if (!md || !md.trim()) return [];
  const blocks = [];
  const lines = md.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    const codeFenceMatch = line.match(/^```(\w*)/);
    if (codeFenceMatch) {
      const lang = codeFenceMatch[1] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      blocks.push(codeBlock(codeLines.join('\n'), lang));
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      blocks.push(dividerBlock());
      i++;
      continue;
    }
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      const level = Math.min(hMatch[1].length, 6);
      blocks.push(headingBlock(level, hMatch[2].trim()));
      i++;
      continue;
    }
    const ulMatch = line.match(/^[-*+]\s+(.+)/);
    if (ulMatch) {
      blocks.push(bulletBlock(parseInline(ulMatch[1].trim())));
      i++;
      continue;
    }
    const olMatch = line.match(/^\d+\.\s+(.+)/);
    if (olMatch) {
      blocks.push(orderedBlock(parseInline(olMatch[1].trim())));
      i++;
      continue;
    }
    if (!line.trim()) { i++; continue; }

    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].match(/^```/) &&
      !lines[i].match(/^#{1,6}\s/) &&
      !lines[i].match(/^[-*+]\s/) &&
      !lines[i].match(/^\d+\.\s/) &&
      !lines[i].match(/^---+$/)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push(paragraphBlock(parseInline(paraLines.join('\n'))));
    }
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Low-level doc ops
// ---------------------------------------------------------------------------

async function createDocument(token, title, folderToken) {
  const body = { title };
  if (folderToken) body.folder_token = folderToken;
  const data = await apiCall('POST', '/docx/v1/documents', token, { body });
  checkApi(data, 'Create document', DOMAIN);
  return data.data.document;
}

async function appendBlocks(token, documentId, blocks) {
  if (!blocks || blocks.length === 0) return;
  const BATCH = 50;
  for (let i = 0; i < blocks.length; i += BATCH) {
    const batch = blocks.slice(i, i + BATCH);
    const data = await apiCall(
      'POST',
      `/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/children`,
      token,
      { body: { children: batch, index: -1 } },
    );
    checkApi(data, 'Append blocks', DOMAIN);
  }
}

async function moveToWikiNode(token, documentId, wikiNode) {
  const nodeToken = wikiNode.includes('/')
    ? wikiNode.split('/').pop().split('?')[0]
    : wikiNode;
  const data = await apiCall('POST', '/wiki/v2/spaces/move_docs_to_wiki', token, {
    body: { parent_wiki_token: nodeToken, obj_type: 'docx', obj_token: documentId },
  });
  checkApi(data, 'Move to wiki', DOMAIN);
  return data.data;
}

// ---------------------------------------------------------------------------
// Action: create
// ---------------------------------------------------------------------------

/**
 * Create a Feishu docx.
 *
 * Args:
 *   title        required
 *   markdown     optional — body content
 *   folder_token optional — parent folder (root if omitted)
 *   wiki_node    optional — move into wiki tree; if this fails we THROW
 */
export async function create(args, token) {
  requireParam(args, 'title', '文档标题');

  const doc = await createDocument(token, args.title, args.folder_token);
  const documentId = doc.document_id;
  const docUrl = `https://www.feishu.cn/docx/${documentId}`;

  if (args.markdown && args.markdown.trim()) {
    const blocks = markdownToBlocks(args.markdown);
    if (blocks.length > 0) {
      await appendBlocks(token, documentId, blocks);
    }
  }

  let wikiMoveResult = null;
  if (args.wiki_node) {
    wikiMoveResult = await moveToWikiNode(token, documentId, args.wiki_node);
  }

  return {
    action: 'create',
    doc_id: documentId,
    doc_url: docUrl,
    title: args.title,
    ...(wikiMoveResult && { wiki_move: wikiMoveResult }),
    reply: `文档「${args.title}」已创建。链接：[${args.title}](${docUrl})`,
  };
}

export const ACTIONS = { create };
export { FeishuError, markdownToBlocks };
