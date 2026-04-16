#!/usr/bin/env node
/**
 * One-shot scaffolder for Phase 3 pipelines (legacy-adapter mode).
 * Creates pipeline.yaml + steps/execute.mjs for each of the 15 remaining skills.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..', '..');

const SKILLS = [
  { name: 'create-doc',     dir: 'feishu-create-doc',     script: 'create-doc.mjs',
    desc: '创建飞书云文档（docx），支持 Markdown 转换',
    triggers: ['创建文档', '新建文档', 'create doc'] },
  { name: 'fetch-doc',      dir: 'feishu-fetch-doc',      script: 'fetch-doc.mjs',
    desc: '读取飞书云文档（docx）内容',
    triggers: ['读文档', '获取文档内容', 'fetch doc'] },
  { name: 'update-doc',     dir: 'feishu-update-doc',     script: 'update-doc.mjs',
    desc: '更新飞书云文档内容',
    triggers: ['更新文档', '修改文档', 'update doc'] },
  { name: 'search-doc',     dir: 'feishu-search-doc',     script: 'search-doc.mjs',
    desc: '搜索飞书文档（按标题/全文）',
    triggers: ['搜索文档', '查找文档', 'search doc'] },
  { name: 'docx-download',  dir: 'feishu-docx-download',  script: 'download-doc.mjs',
    desc: '导出飞书文档为本地文件（docx/pdf）',
    triggers: ['下载文档', '导出文档', 'download doc'] },
  { name: 'doc-comment',    dir: 'feishu-doc-comment',    script: 'comment.mjs',
    desc: '飞书文档评论：增删改查',
    triggers: ['文档评论', 'comment'] },
  { name: 'doc-media',      dir: 'feishu-doc-media',      script: 'media.mjs',
    desc: '飞书文档图片/附件管理',
    triggers: ['文档图片', '文档附件', 'doc media'] },
  { name: 'sheet',          dir: 'feishu-sheet',          script: 'sheet.mjs',
    desc: '飞书电子表格操作（读写单元格、范围、公式）',
    triggers: ['电子表格', 'sheet', '读取表格'] },
  { name: 'wiki',           dir: 'feishu-wiki',           script: 'wiki.mjs',
    desc: '飞书知识库（Wiki）节点管理',
    triggers: ['知识库', 'wiki', '查找 wiki'] },
  { name: 'calendar',       dir: 'feishu-calendar',       script: 'calendar.mjs',
    desc: '飞书日历日程管理（创建/查询/更新事件、freebusy 等）',
    triggers: ['日历', '日程', 'calendar', '创建会议', '查日程'] },
  { name: 'task',           dir: 'feishu-task',           script: 'task.mjs',
    desc: '飞书任务管理（创建/更新/查询任务）',
    triggers: ['任务', 'task', '创建任务'] },
  { name: 'chat',           dir: 'feishu-chat',           script: 'chat.mjs',
    desc: '飞书群组管理（创建/查询/成员管理）',
    triggers: ['群组', 'chat', '创建群', '查群'] },
  { name: 'search-user',    dir: 'feishu-search-user',    script: 'search-user.mjs',
    desc: '搜索飞书用户（仅需 tenant token）',
    triggers: ['搜索用户', 'search user', '查用户'] },
  { name: 'image-ocr',      dir: 'feishu-image-ocr',      script: 'ocr.mjs',
    desc: '图片 OCR 识别（仅需 tenant token）',
    triggers: ['OCR', '图片识别', 'ocr image'] },
  { name: 'im-file-analyze',dir: 'feishu-im-file-analyze',script: 'analyze.mjs',
    desc: '下载并解析飞书 IM 附件（PDF/DOCX/PPTX/XLSX/zip 等）',
    triggers: ['解析附件', '分析文件', 'analyze file'] },
];

// Common input fields used across most skills (matches existing CLI args).
const COMMON_INPUT = `  open_id: string
  action: string
  scope: string`;

const PIPELINE_YAML = (s) => `name: ${s.name}
description: "${s.desc}。auth 由 _constructor 自动处理。"
triggers:
${s.triggers.map(t => `  - "${t}"`).join('\n')}
input:
${COMMON_INPUT}
steps:
  - name: execute
    type: code
    command: "node steps/execute.mjs"
output: execute
`;

const EXECUTE_MJS = (s) => `#!/usr/bin/env node
/**
 * ${s.name} / execute.mjs — thin adapter that spawns legacy script as subprocess.
 * Token already prepared by _constructor (saved to local store).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.resolve(__dirname, '..', '..', '..', 'tools');

const { stdinToOutput } = await import(
  'file://' + path.join(TOOLS_DIR, 'legacy-adapter.mjs').replace(/\\\\/g, '/')
);

await stdinToOutput({
  skillDir: '${s.dir}',
  script: '${s.script}',
  timeoutMs: 120000,
});
`;

let created = 0;
for (const skill of SKILLS) {
  const dir = path.join(APP_DIR, 'pipelines', skill.name);
  const stepsDir = path.join(dir, 'steps');
  fs.mkdirSync(stepsDir, { recursive: true });

  const yamlPath = path.join(dir, 'pipeline.yaml');
  const execPath = path.join(stepsDir, 'execute.mjs');

  fs.writeFileSync(yamlPath, PIPELINE_YAML(skill), 'utf-8');
  fs.writeFileSync(execPath, EXECUTE_MJS(skill), 'utf-8');
  created++;
  console.log(`✓ ${skill.name}`);
}

console.log(`\nCreated ${created} pipelines.`);
