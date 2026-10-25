import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
import { findPython } from '../files.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const fixtureDirectory = path.join(project, 'test-results', 'file-fixtures');
execFileSync(findPython(), [path.join(project, 'tests/make_file_fixtures.py'), fixtureDirectory]);
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'upload-files-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const create = () => createAppServer({ configPath: path.join(dir, 'config.json'), ...options });
  const url = await listen(t, create());
  async function upload(name, content, headers = {}) {
    const response = await fetch(url + '/api/files?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: content });
    return { status: response.status, data: await response.json() };
  }
  async function uploadFixture(name) {
    const result = await upload(name, await readFile(path.join(fixtureDirectory, name)));
    assert.equal(result.status, 201);
    return result.data.file;
  }
  async function preview(file, sheet) {
    return (await (await fetch(url + '/api/files/' + file.id + '/preview' + (sheet ? '?sheet=' + encodeURIComponent(sheet) : ''))).json()).preview;
  }
  return { dir, create, url, upload, uploadFixture, preview };
}

test('批量文件并发保存、同名保留、重启恢复；下载二进制与中文文件名无损', async t => {
  const f = await fixture(t);
  const original = Buffer.from([0, 1, 2, 255, 10, 0]);
  const results = await Promise.all([f.upload('中文附件.bin', original), f.upload('中文附件.bin', original), f.upload('说明.txt', Buffer.from('你好'))]);
  assert.ok(results.every(result => result.status === 201));
  const file = results[0].data.file;
  const second = await listen(t, f.create());
  const list = await (await fetch(second + '/api/files')).json();
  assert.equal(list.files.length, 3);
  assert.notEqual(list.files[0].id, list.files[1].id);
  assert.ok(!JSON.stringify(list).includes(f.dir));
  const downloaded = await fetch(second + '/api/files/' + file.id + '/download');
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream');
  assert.ok(downloaded.headers.get('content-disposition').includes(encodeURIComponent('中文附件.bin')));
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
});

test('CSV 正确读取中文、带逗号字段、多行单元格和 GB18030 编码', async t => {
  const f = await fixture(t);
  const preview = await f.preview(await f.uploadFixture('报价记录.csv'));
  assert.equal(preview.ok, true);
  assert.equal(preview.kind, 'table');
  assert.equal(preview.rows[1][3], '含税,演示单位');
  assert.equal(preview.rows[2][3].replace(/\r\n/g, '\n'), '第一行\n第二行');
  assert.equal(preview.rowCount, 3);
  const gb = await f.preview(await f.uploadFixture('中文编码.csv'));
  assert.equal(gb.rows[1][0], '演示商品C');
  assert.equal(gb.encoding, 'gb18030');
});

test('XLSX 工作表切换、日期和专家意见均可预览，非法表名给出原因', async t => {
  const f = await fixture(t);
  const file = await f.uploadFixture('评测样例.xlsx');
  const preview = await f.preview(file);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.sheets, ['演示数据', '专家意见']);
  assert.equal(preview.rows[1][0], '2026-08-19 00:00:00');
  assert.equal(preview.rows[1][3], '685');
  const other = await f.preview(file, '专家意见');
  assert.equal(other.rows[1][1], '回答应明确日期、规格、单位与含税口径');
  assert.equal((await f.preview(file, '不存在')).ok, false);
});

test('Word 正文、标题和表格按顺序提取', async t => {
  const f = await fixture(t);
  const preview = await f.preview(await f.uploadFixture('专家意见.docx'));
  assert.equal(preview.ok, true);
  assert.equal(preview.kind, 'document');
  assert.equal(preview.blocks[0].type, 'heading');
  assert.equal(preview.blocks[2].type, 'table');
  assert.equal(preview.blocks[2].rows[1][1], '需包含规格与报价口径。');
  assert.equal(preview.blocks[3].text, '表格后的说明。');
});

test('Markdown、TXT、UTF16、空文件和 TSV 均可读取', async t => {
  const f = await fixture(t);
  const markdown = await f.preview(await f.uploadFixture('说明.md'));
  assert.equal(markdown.kind, 'markdown');
  assert.ok(markdown.text.includes('<script>window.injected=true</script>'));
  assert.ok((await f.preview(await f.uploadFixture('备注.txt'))).text.includes('第一条'));
  assert.equal((await f.preview(await f.uploadFixture('UTF16.txt'))).text, '中文 UTF16 文件');
  assert.equal((await f.preview(await f.uploadFixture('空文件.txt'))).text, '');
  assert.equal((await f.preview(await f.uploadFixture('数据.tsv'))).rows[1][1], '正确');
});

test('PDF 可提取文字；未知格式、旧版 DOC 保留下载并说明预览限制', async t => {
  const f = await fixture(t);
  const pdf = await f.preview(await f.uploadFixture('附件.pdf'));
  assert.equal(pdf.ok, true);
  assert.ok(pdf.text.includes('PDF preview test'));
  for (const name of ['附件.bin', '旧版.doc']) {
    const preview = await f.preview(await f.uploadFixture(name));
    assert.equal(preview.ok, true);
    assert.equal(preview.kind, 'unsupported');
    assert.ok(preview.message.length > 0);
  }
});

test('损坏或伪造扩展名给出明确预览失败，原文件仍可下载', async t => {
  const f = await fixture(t);
  const file = await f.uploadFixture('损坏.docx');
  const preview = await f.preview(file);
  assert.equal(preview.ok, false);
  assert.ok(preview.message.includes('无法解析'));
  assert.equal((await fetch(f.url + '/api/files/' + file.id + '/download')).status, 200);
});

test('大表限制预览范围且不裁剪原文件', async t => {
  const f = await fixture(t);
  const file = await f.uploadFixture('多行.xlsx');
  const preview = await f.preview(file);
  assert.equal(preview.rows.length, 200);
  assert.equal(preview.rowCount, 250);
  assert.equal(preview.truncated, true);
  assert.deepEqual(Buffer.from(await (await fetch(f.url + '/api/files/' + file.id + '/download')).arrayBuffer()), await readFile(path.join(fixtureDirectory, '多行.xlsx')));
});

test('大段 UTF-8 中文截断在多字节字符中间时仍正确识别编码', async t => {
  const f = await fixture(t);
  const uploaded = await f.upload('长中文.txt', Buffer.from('中文'.repeat(400000), 'utf8'));
  const preview = await f.preview(uploaded.data.file);
  assert.equal(preview.ok, true);
  assert.equal(preview.encoding, 'utf-8');
  assert.ok(preview.text.startsWith('中文中文'));
  assert.equal(preview.text.length, 200000);
  assert.equal(preview.truncated, true);
});

test('拒绝目录穿越名称、错误 Content-Type、不存在的 ID 与过大请求', async t => {
  const f = await fixture(t);
  for (const name of ['../file.txt', 'a\\file.txt', '', '..', 'bad\nfile']) assert.equal((await f.upload(name, 'bad')).status, 400);
  assert.equal((await f.upload('a.txt', 'bad', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(f.url + '/api/files/00000000-0000-0000-0000-000000000000/preview')).status, 404);
  const oversized = await new Promise((resolve, reject) => {
    const request = http.request(f.url + '/api/files?name=large.txt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 51 * 1024 * 1024 } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject);
    request.end();
  });
  assert.equal(oversized, 413);
});

test('跨站上传被拒绝；不能从静态路径读取原文件', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload('secret.txt', 'content', { Origin: 'https://other.example' })).status, 403);
  const file = await f.uploadFixture('备注.txt');
  assert.equal((await fetch(f.url + '/data/files/' + file.id + '.bin')).status, 404);
  const detail = await (await fetch(f.url + '/api/files/' + file.id)).json();
  assert.equal(detail.file.name, '备注.txt');
  assert.ok(!JSON.stringify(detail).includes(f.dir));
});

test('损坏文件列表不被覆盖，失败上传不会留下额外原文件', async t => {
  const f = await fixture(t);
  await f.uploadFixture('备注.txt');
  const directory = path.join(f.dir, 'files');
  await writeFile(path.join(directory, 'index.json'), 'original-corrupt-content');
  const before = await readdir(directory);
  assert.equal((await f.upload('new.txt', 'new')).status, 500);
  assert.equal(await readFile(path.join(directory, 'index.json'), 'utf8'), 'original-corrupt-content');
  assert.deepEqual((await readdir(directory)).sort(), before.sort());
});

test('重复预览请求合并，避免同一文件同时反复解析', async t => {
  let calls = 0;
  let resolvePreview;
  const f = await fixture(t, { filePreview: async () => { calls += 1; return new Promise(resolve => { resolvePreview = resolve; }); } });
  const file = (await f.upload('file.txt', 'text')).data.file;
  const first = f.preview(file);
  const second = f.preview(file);
  while (!resolvePreview) await new Promise(resolve => setTimeout(resolve, 5));
  await new Promise(resolve => setTimeout(resolve, 25));
  resolvePreview({ ok: true, kind: 'text', text: 'text' });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('按文件 ID 删除并持久化，保留同名文件及归档，所有公开读取入口停止提供已删文件', async t => {
  const f = await fixture(t);
  const content = Buffer.from('需保留的原始资料');
  const removed = (await f.upload('同名源文档.txt', content)).data.file;
  const retained = (await f.upload('同名源文档.txt', '另一份资料')).data.file;
  const response = await fetch(f.url + '/api/files/' + removed.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  const second = await listen(t, f.create());
  const list = await (await fetch(second + '/api/files')).json();
  assert.deepEqual(list.files.map(file => file.id), [retained.id]);
  for (const suffix of ['', '/preview', '/download', '?includeDeleted=true']) assert.equal((await fetch(second + '/api/files/' + removed.id + suffix)).status, 404);
  assert.equal((await fetch(second + '/api/files/' + retained.id + '/download')).status, 200);
  const store = JSON.parse(await readFile(path.join(f.dir, 'files', 'index.json'), 'utf8'));
  assert.ok(store.files.find(file => file.id === removed.id).deletedAt);
  assert.deepEqual(await readFile(path.join(f.dir, 'files', removed.id + '.bin')), content);
  const next = (await f.upload('同名源文档.txt', content)).data.file;
  assert.notEqual(next.id, removed.id);
  assert.equal((await (await fetch(f.url + '/api/files')).json()).files.length, 2);
});

test('并发删除只生效一次，不丢失同时上传的其他文件；拒绝跨站和非 JSON 删除', async t => {
  const f = await fixture(t);
  const file = (await f.upload('待删除.txt', '原始资料')).data.file;
  const remove = headers => fetch(f.url + '/api/files/' + file.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' });
  assert.equal((await remove({ Origin: 'https://other.example' })).status, 403);
  assert.equal((await remove({ 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(f.url + '/api/files/' + file.id)).status, 200);
  const [first, second, uploaded] = await Promise.all([remove(), remove(), f.upload('保留.txt', '新资料')]);
  assert.deepEqual([first.status, second.status].sort(), [200, 404]);
  assert.equal(uploaded.status, 201);
  const list = await (await fetch(f.url + '/api/files')).json();
  assert.deepEqual(list.files.map(item => item.id), [uploaded.data.file.id]);
});

test('删除最后一个文件返回空列表；不存在或损坏索引的删除不会覆盖存储', async t => {
  const f = await fixture(t);
  const file = (await f.upload('最后一份.txt', '资料')).data.file;
  const remove = () => fetch(f.url + '/api/files/' + file.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal((await remove()).status, 200);
  assert.deepEqual((await (await fetch(f.url + '/api/files')).json()).files, []);
  const filename = path.join(f.dir, 'files', 'index.json');
  const saved = await readFile(filename, 'utf8');
  assert.equal((await remove()).status, 404);
  assert.equal(await readFile(filename, 'utf8'), saved);
  await writeFile(filename, 'original-corrupt-content');
  assert.equal((await remove()).status, 500);
  assert.equal(await readFile(filename, 'utf8'), 'original-corrupt-content');
});
