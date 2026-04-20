/**
 * tools/lib/extract.mjs — Universal text extraction for local files.
 *
 * Previously lived at tools/legacy/feishu-docx-download/extract.mjs; moved here
 * as part of the spec-compliant refactor. Programmatic API only (no CLI entry).
 *
 * Supported formats: docx, pdf, pptx, xlsx, xls, doc, ppt, rtf, epub, html, htm, txt, csv, md
 * Missing npm dependencies are auto-installed on first run (adm-zip, pdf-parse, xlsx, officeparser, iconv-lite).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function ensurePkg(nameWithVersion) {
  const name = nameWithVersion.split('@')[0];
  try { return require(name); }
  catch {
    process.stderr.write(`[extract] Installing ${nameWithVersion}...\n`);
    execSync(`npm install ${nameWithVersion} --no-save --prefix "${__dirname}"`, { stdio: 'pipe' });
    return require(name);
  }
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

function extractDocx(filePath) {
  const AdmZip = ensurePkg('adm-zip');
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry('word/document.xml');
  if (!entry) throw new Error('缺少 word/document.xml，文件不完整。');
  const xml = entry.getData().toString('utf-8');

  const imageCount = (xml.match(/<wp:inline\b/g) || []).length || (xml.match(/<a:blip\b/g) || []).length;
  const oleCount = (xml.match(/<o:OLEObject\b/g) || []).length;

  const lines = [];
  const tables = [];
  const tableRegex = /<w:tbl\b[^>]*>([\s\S]*?)<\/w:tbl>/g;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(xml)) !== null) {
    const tableXml = tableMatch[0];
    const rows = [];
    const rowRegex = /<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(tableXml)) !== null) {
      const cells = [];
      const cellRegex = /<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g;
      let cellMatch;
      while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
        const cellText = extractParagraphTexts(cellMatch[0]).join(' ');
        cells.push(cellText);
      }
      rows.push(cells);
    }
    tables.push({ index: tableMatch.index, rows });
  }

  let cursor = 0;
  for (const t of tables) {
    if (t.index > cursor) lines.push(...extractParagraphTexts(xml.slice(cursor, t.index)));
    for (const row of t.rows) lines.push(row.join('\t'));
    lines.push('');
    cursor = t.index + xml.slice(t.index).match(/<w:tbl\b[^>]*>[\s\S]*?<\/w:tbl>/)[0].length;
  }
  if (cursor < xml.length) lines.push(...extractParagraphTexts(xml.slice(cursor)));

  const notes = [];
  if (imageCount > 0) notes.push(`[文档包含 ${imageCount} 张图片]`);
  if (oleCount > 0) notes.push(`[文档包含 ${oleCount} 个嵌入对象]`);
  if (notes.length) lines.push('', notes.join(' '));

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function extractParagraphTexts(xml) {
  const results = [];
  const pRegex = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let pMatch;
  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pXml = pMatch[0];
    const hasImage = /<a:blip\b/.test(pXml) || /<wp:inline\b/.test(pXml);
    const texts = [];
    const tRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let tMatch;
    while ((tMatch = tRegex.exec(pXml)) !== null) texts.push(tMatch[1]);
    let line = texts.join('');
    if (hasImage && !line) line = '[图片]';
    else if (hasImage) line += ' [图片]';
    if (line) results.push(line);
  }
  return results;
}

function extractPdf(filePath) {
  const pdfParse = ensurePkg('pdf-parse@1.1.1');
  const buf = fs.readFileSync(filePath);
  return pdfParse(buf).then((data) => {
    const text = (data.text || '').trim();
    if (!text) return '[PDF 未提取到文本内容，可能是扫描件或纯图片 PDF]';
    return text;
  });
}

function extractPptx(filePath) {
  const AdmZip = ensurePkg('adm-zip');
  let zip;
  try { zip = new AdmZip(filePath); } catch (e) { throw new Error(`无法打开 PPTX 文件: ${e.message}`); }
  const entries = zip.getEntries().filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.entryName));
  if (!entries.length) throw new Error('PPTX 中未找到幻灯片，文件可能损坏。');
  entries.sort((a, b) => parseInt(a.entryName.match(/slide(\d+)/)[1]) - parseInt(b.entryName.match(/slide(\d+)/)[1]));

  const parts = [];
  entries.forEach((entry, idx) => {
    const xml = entry.getData().toString('utf-8');
    const slideLines = [];
    const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
    let pMatch;
    while ((pMatch = pRegex.exec(xml)) !== null) {
      const texts = [];
      const tRegex = /<a:t>([^<]*)<\/a:t>/g;
      let tMatch;
      while ((tMatch = tRegex.exec(pMatch[0])) !== null) texts.push(tMatch[1]);
      const line = texts.join('').trim();
      if (line) slideLines.push(line);
    }
    const imageCount = (xml.match(/<a:blip\b/g) || []).length;
    if (imageCount) slideLines.push(`[${imageCount} 张图片]`);

    const tableRegex = /<a:tbl\b[^>]*>([\s\S]*?)<\/a:tbl>/g;
    let tblMatch;
    while ((tblMatch = tableRegex.exec(xml)) !== null) {
      const rowRegex = /<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g;
      let rowMatch;
      while ((rowMatch = rowRegex.exec(tblMatch[0])) !== null) {
        const cells = [];
        const cellRegex = /<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g;
        let cellMatch;
        while ((cellMatch = cellRegex.exec(rowMatch[0])) !== null) {
          const cellTexts = [];
          const ctRegex = /<a:t>([^<]*)<\/a:t>/g;
          let ct;
          while ((ct = ctRegex.exec(cellMatch[0])) !== null) cellTexts.push(ct[1]);
          cells.push(cellTexts.join('').trim());
        }
        if (cells.some((c) => c)) slideLines.push(cells.join('\t'));
      }
    }
    if (slideLines.length) parts.push(`--- 第${idx + 1}页 ---\n${slideLines.join('\n')}`);
  });
  return parts.join('\n\n');
}

function extractXlsx(filePath) {
  const MAX_ROWS = 2000;
  const XLSX = ensurePkg('xlsx');
  let wb;
  try { wb = XLSX.readFile(filePath, { cellDates: true }); } catch (e) { throw new Error(`无法打开 Excel 文件: ${e.message}`); }
  const parts = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const ref = sheet['!ref'];
    if (!ref) continue;
    const range = XLSX.utils.decode_range(ref);
    const totalRows = range.e.r - range.s.r + 1;
    const totalCols = range.e.c - range.s.c + 1;
    if (sheet['!merges']) {
      for (const merge of sheet['!merges']) {
        const origin = sheet[XLSX.utils.encode_cell({ r: merge.s.r, c: merge.s.c })];
        if (!origin) continue;
        for (let r = merge.s.r; r <= merge.e.r; r++) {
          for (let c = merge.s.c; c <= merge.e.c; c++) {
            if (r === merge.s.r && c === merge.s.c) continue;
            sheet[XLSX.utils.encode_cell({ r, c })] = { ...origin };
          }
        }
      }
    }
    parts.push(`--- ${name} (${totalRows}行 × ${totalCols}列) ---`);
    const truncated = totalRows > MAX_ROWS;
    const outputRange = truncated ? { s: range.s, e: { r: range.s.r + MAX_ROWS - 1, c: range.e.c } } : range;
    const csv = XLSX.utils.sheet_to_csv(sheet, { FS: '\t', range: outputRange, dateNF: 'yyyy-mm-dd' });
    if (csv.trim()) parts.push(csv.trim());
    if (truncated) parts.push(`[... 已截断，仅显示前 ${MAX_ROWS} 行，共 ${totalRows} 行]`);
  }
  if (!parts.length) return '[Excel 文件中没有包含数据的工作表]';
  return parts.join('\n');
}

function extractOldOffice(filePath) {
  const { parseOffice } = ensurePkg('officeparser');
  return new Promise((resolve) => {
    parseOffice(filePath, (err, data) => {
      if (err) {
        resolve('WARN: 旧版格式提取内容可能不完整，建议转换为新版格式后重新上传。\n' + (err.message || ''));
      } else {
        resolve((data || '').trim());
      }
    });
  });
}

function extractRtf(filePath) {
  const buf = fs.readFileSync(filePath, 'utf-8');
  return buf
    .replace(/\{\\[^{}]*\}/g, '')
    .replace(/\\[a-z]+\d*\s?/gi, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractEpub(filePath) {
  const AdmZip = ensurePkg('adm-zip');
  let zip;
  try { zip = new AdmZip(filePath); } catch (e) { throw new Error(`无法打开 EPUB 文件: ${e.message}`); }
  const parts = [];
  for (const entry of zip.getEntries()) {
    if (/\.(xhtml|html|htm)$/i.test(entry.entryName) && !/META-INF/i.test(entry.entryName)) {
      let html = entry.getData().toString('utf-8');
      html = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
      const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) parts.push(text);
    }
  }
  return parts.join('\n\n');
}

function extractHtml(filePath) {
  let html = readWithFallbackEncoding(filePath);
  html = html.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '');
  let text = html.replace(/<[^>]+>/g, ' ');
  text = text.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return text.replace(/\s+/g, ' ').trim();
}

function extractPlainText(filePath) {
  return readWithFallbackEncoding(filePath);
}

function readWithFallbackEncoding(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) return raw.toString('utf-8');
  if (raw[0] === 0xFF && raw[1] === 0xFE) return raw.toString('utf16le');
  const utf8 = raw.toString('utf-8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try {
    const iconv = ensurePkg('iconv-lite');
    if (iconv.encodingExists('gbk')) {
      const gbk = iconv.decode(raw, 'gbk');
      if (!gbk.includes('\uFFFD')) return gbk;
    }
  } catch { /* iconv-lite not available */ }
  return raw.toString('latin1');
}

const EXTRACTORS = {
  docx: extractDocx,
  pdf: extractPdf,
  pptx: extractPptx,
  xlsx: extractXlsx,
  xls: extractXlsx,
  doc: extractOldOffice,
  ppt: extractOldOffice,
  rtf: extractRtf,
  epub: extractEpub,
  html: extractHtml,
  htm: extractHtml,
  txt: extractPlainText,
  csv: extractPlainText,
  md: extractPlainText,
};

export const SUPPORTED_FORMATS = Object.keys(EXTRACTORS);

/**
 * Programmatic API — extract plain text from a local file.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {boolean} [opts.skipSmallFileCheck=false]
 * @returns {Promise<{format:string, text:string, charCount:number, imageCount:number}>}
 * @throws Error with .code in { 'file_not_found' | 'file_too_small' | 'unsupported_format' | 'extract_error' }
 */
export async function extractFile(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) {
    const e = new Error(`File not found: ${filePath}`);
    e.code = 'file_not_found';
    throw e;
  }
  const size = fs.statSync(filePath).size;
  if (!opts.skipSmallFileCheck && size < 512) {
    const e = new Error(`文件太小（${size} bytes），可能是预览版，请确认 drive:file:download 权限已开通。`);
    e.code = 'file_too_small';
    throw e;
  }
  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const extractor = EXTRACTORS[ext];
  if (!extractor) {
    const e = new Error(`不支持的文件格式: .${ext}，支持: ${SUPPORTED_FORMATS.join(', ')}`);
    e.code = 'unsupported_format';
    e.format = ext;
    throw e;
  }
  let text;
  try {
    text = (await Promise.resolve(extractor(filePath))) || '';
  } catch (err) {
    const e = new Error(err.message);
    e.code = 'extract_error';
    e.format = ext;
    throw e;
  }
  const imageMatch = text.match(/\[文档包含 (\d+) 张图片\]/);
  const imageCount = imageMatch ? parseInt(imageMatch[1], 10) : (text.match(/\[图片\]/g) || []).length;
  return { format: ext, text, charCount: text.length, imageCount };
}
