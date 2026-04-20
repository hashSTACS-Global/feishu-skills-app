#!/usr/bin/env node
/**
 * tests/fail_fast.test.mjs — verify that refactored libs reject bad input
 * up-front instead of letting Feishu return opaque errors.
 *
 * No real API calls. Each case constructs minimal args and expects a thrown
 * FeishuError with a specific .code before any fetch happens.
 *
 * Run from feishu-skills-app/:
 *   node tests/fail_fast.test.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function importLib(name) {
  return import(
    'file://' + path.join(ROOT, 'tools', 'lib', `${name}.mjs`).replace(/\\/g, '/')
  );
}

const results = [];
async function expect(label, fn, wantCode, wantMsgPart) {
  try {
    await fn();
    results.push({ label, ok: false, reason: '无异常，但期望 ' + wantCode });
    return;
  } catch (err) {
    const actual = err.code || '(no code)';
    const msgOk = wantMsgPart ? (err.message || '').includes(wantMsgPart) : true;
    if (actual === wantCode && msgOk) {
      results.push({ label, ok: true, code: actual });
    } else {
      results.push({ label, ok: false, reason: `got code=${actual} msg=${(err.message || '').slice(0, 80)}` });
    }
  }
}

(async () => {
  const { ACTIONS: bitable } = await importLib('bitables');
  const { ACTIONS: drive } = await importLib('drive');
  const imMsgMod = await importLib('im-message');
  const imMsg = { send: imMsgMod.sendMessage, reply: imMsgMod.replyMessage };
  const imReadMod = await importLib('im-read');
  const imRead = { get_messages: imReadMod.getMessages, search_messages: imReadMod.searchMessages };
  const { ACTIONS: calendar } = await importLib('calendar');
  const { ACTIONS: chat } = await importLib('chat');
  const { ACTIONS: createDoc } = await importLib('create-doc');
  const { ACTIONS: docComment } = await importLib('doc-comment');
  const { ACTIONS: docMedia } = await importLib('doc-media');
  const { ACTIONS: docxDl } = await importLib('docx-download');
  const { ACTIONS: fetchDoc } = await importLib('fetch-doc');
  const { ACTIONS: ocr } = await importLib('image-ocr');
  const { ACTIONS: searchDoc } = await importLib('search-doc');
  const { ACTIONS: searchUser } = await importLib('search-user');
  const { ACTIONS: sheet } = await importLib('sheet');
  const { ACTIONS: task } = await importLib('task');
  const { ACTIONS: updateDoc } = await importLib('update-doc');
  const { ACTIONS: wiki } = await importLib('wiki');

  // bitable — the headline fail-fast cases the user got burned on
  await expect('bitable.update_field 不传 field_type',
    () => bitable.update_field({ app_token: 'a', table_id: 't', field_id: 'f', name: 'x' }, 'T'),
    'missing_param', 'field_type');
  await expect('bitable.create_field color 字符串',
    () => bitable.create_field({ app_token: 'a', table_id: 't', name: 'x', field_type: 3, property: { options: [{ name: 'a', color: 'red' }] } }, 'T'),
    'invalid_param', 'color 必须是整数');
  await expect('bitable.create_table fields color 字符串',
    () => bitable.create_table({ app_token: 'a', name: 't', fields: [{ field_name: 'f', type: 3, property: { options: [{ name: 'a', color: 'red' }] } }] }, 'T'),
    'invalid_param', 'color');
  await expect('bitable.batch_create_records records 非数组',
    () => bitable.batch_create_records({ app_token: 'a', table_id: 't', records: 'not-array' }, 'T'),
    'invalid_param');
  await expect('bitable.create_app 不传 name',
    () => bitable.create_app({}, 'T'),
    'missing_param', 'name');

  // drive — listFolder no longer auto-paginates; bad page_size rejected
  await expect('drive.list page_size > 200',
    () => drive.list('T', { page_size: 999 }),
    'invalid_param', 'page_size');
  await expect('drive.create_folder 不传 name',
    () => drive.create_folder('T', {}),
    'missing_param', 'name');
  await expect('drive.get_meta request_docs 字符串',
    () => drive.get_meta('T', { request_docs: 'tok1:docx' }),
    'invalid_param', 'request_docs');
  await expect('drive.list folder_token=im file_key',
    () => drive.list('T', { folder_token: 'file_v3_xxx' }),
    'invalid_im_file_key');

  // im-message — no silent JSON.stringify / msg_type override
  await expect('im-message.send content 是 object',
    () => imMsg.send({ receive_id_type: 'open_id', receive_id: 'ou_x', msg_type: 'text', content: { text: 'hi' } }, 'T', {}),
    'invalid_param', 'JSON 字符串');
  await expect('im-message.send image_path 但 msg_type != image',
    () => imMsg.send({ receive_id_type: 'open_id', receive_id: 'ou_x', msg_type: 'text', image_path: '/tmp/a.png' }, 'T', {}),
    'invalid_param', 'image_path');

  // im-read — resolveP2P 不再静默 fallback, comma-string 不再接受
  await expect('im-read.search_messages sender_ids 是逗号字符串',
    () => imRead.search_messages({ query: 'x', sender_ids: 'a,b' }, 'T'),
    'invalid_param');
  await expect('im-read.get_messages 无 chat_id/target_open_id',
    () => imRead.get_messages({}, 'T'),
    'missing_param');

  // calendar — no 'primary' default, no comma-string attendees
  await expect('calendar.create_event 无 calendar_id',
    () => calendar.create_event({ summary: 'x', start_time: '2026-04-20T10:00:00+08:00', end_time: '2026-04-20T11:00:00+08:00' }, 'T'),
    'missing_param', 'calendar_id');
  await expect('calendar.create_event 非全天无 time_zone',
    () => calendar.create_event({ calendar_id: 'c', summary: 'x', start_time: '2026-04-20T10', end_time: '2026-04-20T11' }, 'T'),
    'missing_param', 'time_zone');
  await expect('calendar.add_attendees attendee_ids 逗号字符串',
    () => calendar.add_attendees({ calendar_id: 'c', event_id: 'e', attendee_ids: 'a,b' }, 'T'),
    'invalid_param');

  // chat — bad user_id_type enum
  await expect('chat.list_members 非法 user_id_type',
    () => chat.list_members({ chat_id: 'oc_x', user_id_type: 'bad' }, 'T'),
    'invalid_param');

  // create-doc — no title default
  await expect('create-doc.create 无 title',
    () => createDoc.create({}, 'T'),
    'missing_param', 'title');

  // doc-comment — is_solved 不再接受字符串
  await expect('doc-comment.patch is_solved 字符串',
    () => docComment.patch({ file_token: 't', file_type: 'docx', comment_id: 'c', is_solved: 'true' }, 'T'),
    'invalid_param');

  // doc-media — no MIME inference; output_path 须带扩展名
  await expect('doc-media.download output_path 无扩展名',
    () => docMedia.download({ resource_token: 'x', resource_type: 'media', output_path: '/tmp/foo' }, 'T'),
    'invalid_param');
  await expect('doc-media.insert image 无 align',
    () => docMedia.insert({ document_id: 'x', file_path: '/tmp/y.png', type: 'image' }, 'T'),
    'missing_param');

  // docx-download — caller 显式 source_type
  await expect('docx-download.download 无 source_type',
    () => docxDl.download({ token: 'x' }, 'T'),
    'missing_param', 'source_type');
  await expect('docx-download.download 无 output_name',
    () => docxDl.download({ source_type: 'wiki', token: 'x', output_dir: '/tmp' }, 'T'),
    'missing_param', 'output_name');

  // fetch-doc
  await expect('fetch-doc.fetch 无 doc_id',
    () => fetchDoc.fetch({}, 'T'),
    'missing_param', 'doc_id');

  // image-ocr
  await expect('image-ocr.recognize 无 image',
    () => ocr.recognize({}, 'T', { appId: 'a', appSecret: 'b' }),
    'missing_param', 'image');
  await expect('image-ocr.recognize 文件不存在',
    () => ocr.recognize({ image: '/nonexistent/xyz.png' }, 'T', { appId: 'a', appSecret: 'b' }),
    'file_not_found');

  // search-doc
  await expect('search-doc.docs 无 query',
    () => searchDoc.docs({}, 'T'),
    'missing_param', 'query');
  await expect('search-doc.wiki_nodes 无 wiki_space_id',
    () => searchDoc.wiki_nodes({ query: 'x' }, 'T'),
    'missing_param', 'wiki_space_id');

  // search-user
  await expect('search-user.search 无 query',
    () => searchUser.search({}, 'T'),
    'missing_param');
  await expect('search-user.get 非法 user_id_type',
    () => searchUser.get({ user_id: 'u', user_id_type: 'bad' }, 'T'),
    'invalid_param');

  // sheet — no URL parsing, no wiki auto-resolve
  await expect('sheet.read 无 range/sheet_id',
    () => sheet.read({ spreadsheet_token: 'x' }, 'T'),
    'missing_param');
  await expect('sheet.info 无 spreadsheet_token',
    () => sheet.info({}, 'T'),
    'missing_param');
  await expect('sheet.write values 不是二维数组',
    () => sheet.write({ spreadsheet_token: 'x', range: 'a!A1', values: 'not-array' }, 'T'),
    'invalid_param');

  // task — completed 须 bool, members 须数组
  await expect('task.create_task 无 summary',
    () => task.create_task({}, 'T'),
    'missing_param', 'summary');
  await expect('task.list_tasks completed 是字符串',
    () => task.list_tasks({ completed: 'true' }, 'T'),
    'invalid_param');
  await expect('task.create_task members 是字符串',
    () => task.create_task({ summary: 'x', members: 'a,b' }, 'T'),
    'invalid_param');

  // update-doc — 无 mode 默认，action 必传
  await expect('update-doc.append 无 doc_id',
    () => updateDoc.append({ markdown: 'x' }, 'T'),
    'missing_param', 'doc_id');
  await expect('update-doc.overwrite 无 markdown',
    () => updateDoc.overwrite({ doc_id: 'x' }, 'T'),
    'missing_param');

  // wiki — node_create 非法 obj_type
  await expect('wiki.node_create 非法 obj_type',
    () => wiki.node_create({ space_id: 's', obj_type: 'pptx', node_type: 'origin' }, 'T'),
    'invalid_param', 'obj_type');
  await expect('wiki.node_create shortcut 缺 origin_node_token',
    () => wiki.node_create({ space_id: 's', obj_type: 'docx', node_type: 'shortcut' }, 'T'),
    'missing_param', 'origin_node_token');

  // Report
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok);
  console.log(`\nfail-fast cases: ${passed}/${results.length} passed\n`);
  if (failed.length > 0) {
    console.log('FAILURES:');
    for (const f of failed) console.log(`  [FAIL] ${f.label}: ${f.reason}`);
    process.exit(1);
  }
})();
