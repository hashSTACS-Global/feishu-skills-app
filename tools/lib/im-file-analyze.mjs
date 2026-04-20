/**
 * tools/lib/im-file-analyze.mjs — download & extract text from IM attachments.
 *
 * Single action: analyze.
 *
 * Contract:
 *   - Provide (message_id, file_key) to download from IM, OR local_path for a local file.
 *   - Tenant token acquisition uses cfg.appId + cfg.appSecret.
 *   - Pre-flight on IM message (msg_type=folder → fail fast with structured error).
 *   - Known Feishu error codes (234003, 99991672/9, permission msgs) → structured errors.
 *   - System tool `unzip` is required for zip archives. If missing → structured error.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { FeishuError, apiCall, checkApi, requireParam } from './_common.mjs';
import { getTenantAccessToken } from '../auth.mjs';
import { extractFile } from './extract.mjs';

const DOMAIN = { domain: 'im-file-analyze' };

const TEXT_EXTS = new Set(['.txt', '.md', '.csv', '.json', '.log', '.xml', '.html', '.htm', '.yaml', '.yml', '.ini', '.conf', '.tsv']);
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

function which(tool) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const p = execFileSync(cmd, [tool], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return p.split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function requireTool(tool, installHint) {
  if (!which(tool)) {
    throw new FeishuError('missing_system_tool', `系统未安装 \`${tool}\`，请先安装：${installHint}`, {
      tool,
      install_hint: installHint,
      reply: `系统未安装 \`${tool}\`，请先安装：${installHint}`,
    });
  }
}

// ---------------------------------------------------------------------------
// IM resource download
// ---------------------------------------------------------------------------

async function fetchMessageMeta(messageId, token) {
  const data = await apiCall('GET', `/im/v1/messages/${encodeURIComponent(messageId)}`, token);
  if (data.code !== 0) {
    return { ok: false, code: data.code, msg: data.msg };
  }
  const item = data.data?.items?.[0] || null;
  if (!item) return { ok: false, code: -1, msg: 'message not found' };
  let content = {};
  try { content = JSON.parse(item.body?.content || '{}'); } catch { /* ignore */ }
  return { ok: true, msg_type: item.msg_type, content };
}

async function downloadIMResource(messageId, fileKey, outPath, cfg) {
  if (!cfg?.appId || !cfg?.appSecret) {
    throw new FeishuError('missing_param', 'im-file-analyze 需要 cfg.appId + cfg.appSecret', { param: 'cfg' });
  }
  const token = await getTenantAccessToken(cfg.appId, cfg.appSecret);

  const meta = await fetchMessageMeta(messageId, token);
  if (meta.ok) {
    if (meta.msg_type === 'folder') {
      const fname = meta.content?.file_name;
      throw new FeishuError(
        'folder_attachment_not_supported',
        `IM 文件夹附件当前飞书 open API 未公开下载接口${fname ? `（文件夹名：${fname}）` : ''}`,
        {
          msg_type: 'folder',
          file_name: fname,
          reply: `📁 这是一条 IM 文件夹附件（msg_type=folder${fname ? `，文件夹名「${fname}」` : ''}），当前飞书 open API 未公开其下载接口。\n请让发送者改用：\n  1. 本地把文件夹压缩为 .zip 再发送；\n  2. 上传到飞书云盘后分享 https://xxx.feishu.cn/drive/folder/<token> 链接`,
        },
      );
    }
    if (meta.content?.file_key && meta.content.file_key !== fileKey) {
      throw new FeishuError(
        'file_key_mismatch',
        'file_key 与 message_id 不匹配',
        {
          msg_type: meta.msg_type,
          expected_file_key: meta.content.file_key,
          got_file_key: fileKey,
          reply: '❌ file_key 与 message_id 不匹配：请确认两者来自同一条消息',
        },
      );
    }
  }

  const url = `/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`;
  const res = await apiCall('GET', url, token, { query: { type: 'file' }, raw: true });
  const contentType = res.headers.get('content-type') || '';

  if (contentType.includes('application/json') || res.status >= 400) {
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
    const code = parsed?.code;

    if (code === 234003 || /File not in msg/i.test(parsed?.msg || '')) {
      throw new FeishuError(
        'resource_not_found',
        `飞书返回 234003：${parsed?.msg || 'File not in msg.'}`,
        {
          feishu_code: code,
          feishu_msg: parsed?.msg,
          possible_causes: [
            'message_id 与 file_key 不匹配（最常见——检查两者是否来自同一条消息）',
            'file_key 已过期（飞书 IM 附件 file_key 有有效期）',
            '消息已撤回或机器人无权访问该消息',
          ],
          reply: `❌ 无法下载该附件（飞书返回 234003 "${parsed?.msg || 'File not in msg.'}"）。\n可能原因：message_id 与 file_key 不匹配、file_key 过期、消息撤回。\n建议先核对 message_id 和 file_key 是否匹配`,
        },
      );
    }
    if (code === 99991672 || code === 99991679 || /permission|scope/i.test(parsed?.msg || '')) {
      throw new FeishuError(
        'permission_required',
        `Download IM resource failed: code=${code} msg=${parsed?.msg || ''}`,
        {
          required_scopes: ['im:resource'],
          reply: '⚠️ 应用缺少 `im:resource` 权限，无法下载 IM 附件。请管理员在飞书开放平台开通',
          feishu_code: code,
          feishu_msg: parsed?.msg,
        },
      );
    }
    throw new FeishuError('download_failed', `HTTP ${res.status}: ${text.slice(0, 300)}`, { http_status: res.status });
  }

  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(outPath, buf);

  const cd = res.headers.get('content-disposition') || '';
  let filename = null;
  const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  if (m) {
    try { filename = decodeURIComponent(m[1]); } catch { filename = m[1]; }
  }
  return { size: buf.length, filename };
}

// ---------------------------------------------------------------------------
// Magic-byte detection + zip handling
// ---------------------------------------------------------------------------

function detectKind(buf, ext) {
  if (buf && buf.length >= 4) {
    const b = buf;
    if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 0x03 || b[2] === 0x05 || b[2] === 0x07)) {
      if (ext === '.docx') return 'docx';
      return 'zip';
    }
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  }
  if (ext === '.pdf') return 'pdf';
  if (ext === '.zip') return 'zip';
  if (ext === '.docx') return 'docx';
  if (TEXT_EXTS.has(ext)) return 'text';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return 'unsupported';
}

function truncate(s, maxBytes) {
  if (!s) return { text: '', truncated: false };
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  return { text: buf.slice(0, maxBytes).toString('utf8'), truncated: true };
}

function listZip(zipPath) {
  const outStr = execFileSync('unzip', ['-l', zipPath], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
  const lines = outStr.split(/\r?\n/);
  const entries = [];
  let totalBytes = 0;
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+(.+)$/);
    if (m) {
      const size = parseInt(m[1], 10);
      const name = m[2];
      if (!name.endsWith('/')) {
        entries.push({ name, size });
        totalBytes += size;
      }
    }
  }
  return { entries, totalBytes };
}

function extractZipTo(zipPath, tmpRoot) {
  requireTool('unzip', 'apt install unzip / brew install unzip / choco install unzip');
  const dest = fs.mkdtempSync(path.join(tmpRoot, 'zip-'));
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dest], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
  return dest;
}

function walk(dir, rootDir, out) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  for (const it of items) {
    const full = path.join(dir, it.name);
    if (it.isDirectory()) walk(full, rootDir, out);
    else if (it.isFile()) {
      const rel = path.relative(rootDir, full);
      const st = fs.statSync(full);
      out.push({ abs: full, rel, size: st.size });
    }
  }
}

async function analyzeSingleFile(filePath, displayName, limits, warnings) {
  const size = fs.statSync(filePath).size;
  if (size > limits.maxSize) {
    warnings.push(`跳过 ${displayName}：超过单文件上限 ${limits.maxSize} 字节`);
    return { path: displayName, size, type: 'skipped_too_large' };
  }

  const ext = path.extname(displayName).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return {
      path: displayName,
      size,
      type: 'image',
      text: '',
      truncated: false,
      note: '图片文件，如需识别文字请调用 image-ocr pipeline',
    };
  }

  try {
    const { format, text, imageCount } = await extractFile(filePath, { skipSmallFileCheck: true });
    const t = truncate(text, limits.perFileBytes);
    const item = { path: displayName, size, type: format, text: t.text, truncated: t.truncated };
    if (imageCount > 0) item.image_count = imageCount;
    return item;
  } catch (e) {
    if (e.code === 'unsupported_format') {
      return { path: displayName, size, type: 'unsupported', text: '', truncated: false };
    }
    return { path: displayName, size, type: 'error', text: '', truncated: false, error: `${e.code || 'extract_error'}: ${e.message}` };
  }
}

// ---------------------------------------------------------------------------
// Action: analyze
// ---------------------------------------------------------------------------

export async function analyze(args, _accessToken, cfg) {
  const usingIM = args.message_id && args.file_key;
  if (!usingIM && !args.local_path) {
    throw new FeishuError(
      'missing_param',
      '必须提供 message_id + file_key（从 IM 下载），或 local_path（本地文件）',
      { params: ['message_id', 'file_key', 'local_path'] },
    );
  }

  const maxSizeMb = args.max_size_mb ?? 50;
  const maxFiles = args.max_files ?? 100;
  const maxTextKb = args.max_text_kb ?? 200;
  const perFileKb = args.per_file_kb ?? 20;
  const keepTemp = args.keep_temp === true;

  [
    ['max_size_mb', maxSizeMb],
    ['max_files', maxFiles],
    ['max_text_kb', maxTextKb],
    ['per_file_kb', perFileKb],
  ].forEach(([name, v]) => {
    if (!Number.isFinite(v) || v < 1) {
      throw new FeishuError('invalid_param', `${name} 必须是正整数`, { param: name });
    }
  });

  const limits = {
    maxSize: maxSizeMb * 1024 * 1024,
    maxFiles,
    maxTextBytes: maxTextKb * 1024,
    perFileBytes: perFileKb * 1024,
  };

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-analyze-'));
  const warnings = [];
  const source = {};
  let workPath = args.local_path;
  let rootName = args.local_path ? path.basename(args.local_path) : 'attachment.bin';

  try {
    if (usingIM) {
      const dlPath = path.join(tmpRoot, 'download.bin');
      const info = await downloadIMResource(args.message_id, args.file_key, dlPath, cfg);
      workPath = dlPath;
      if (info.filename) rootName = info.filename;
      source.kind = 'im';
      source.message_id = args.message_id;
      source.file_key = args.file_key;
      source.filename = info.filename;
      source.downloaded_bytes = info.size;
    } else {
      source.kind = 'local';
      source.path = path.resolve(args.local_path);
    }

    const st = fs.statSync(workPath);
    if (st.size > limits.maxSize) {
      throw new FeishuError(
        'file_too_large',
        `文件 ${(st.size / 1024 / 1024).toFixed(1)} MB 超过上限 ${maxSizeMb} MB`,
        { size_mb: +(st.size / 1024 / 1024).toFixed(2), limit_mb: maxSizeMb },
      );
    }

    let head = Buffer.alloc(8);
    try {
      const fd = fs.openSync(workPath, 'r');
      fs.readSync(fd, head, 0, 8, 0);
      fs.closeSync(fd);
    } catch { /* best effort */ }
    const rootExt = path.extname(rootName).toLowerCase();
    const rootKind = detectKind(head, rootExt);

    const files = [];
    let totalText = 0;
    let textTruncated = false;

    if (rootKind === 'zip') {
      requireTool('unzip', 'apt install unzip / brew install unzip / choco install unzip');
      const listing = listZip(workPath);
      if (listing.entries.length > limits.maxFiles) {
        throw new FeishuError(
          'too_many_files',
          `zip 内 ${listing.entries.length} 个文件，超出 ${limits.maxFiles} 上限`,
          { count: listing.entries.length, limit: limits.maxFiles },
        );
      }
      if (listing.totalBytes > limits.maxSize * 2) {
        warnings.push(`zip 解压后估计 ${(listing.totalBytes / 1024 / 1024).toFixed(1)}MB，较大`);
      }

      const extractDir = extractZipTo(workPath, tmpRoot);
      const walked = [];
      walk(extractDir, extractDir, walked);
      for (const f of walked) {
        if (totalText >= limits.maxTextBytes) {
          textTruncated = true;
          warnings.push(`总文本达上限 ${maxTextKb}KB，停止抽取剩余文件`);
          break;
        }
        const remaining = limits.maxTextBytes - totalText;
        const perFile = Math.min(limits.perFileBytes, remaining);
        const item = await analyzeSingleFile(f.abs, f.rel, { ...limits, perFileBytes: perFile }, warnings);
        if (item.text) totalText += Buffer.byteLength(item.text, 'utf8');
        files.push(item);
      }
    } else {
      const item = await analyzeSingleFile(workPath, rootName, limits, warnings);
      if (item.text) totalText += Buffer.byteLength(item.text, 'utf8');
      files.push(item);
    }

    const totalTextKb = +(totalText / 1024).toFixed(2);
    return {
      action: 'analyze',
      source,
      root_name: rootName,
      root_type: rootKind,
      files,
      total_files: files.length,
      total_text_bytes: totalText,
      total_text_kb: totalTextKb,
      text_truncated: textTruncated,
      warnings,
      reply: `已解析「${rootName}」的 ${files.length} 个文件，共 ${totalTextKb}KB 文本${textTruncated ? '（已截断）' : ''}。`,
    };
  } finally {
    if (!keepTemp) {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

export const ACTIONS = { analyze };
export { FeishuError };
