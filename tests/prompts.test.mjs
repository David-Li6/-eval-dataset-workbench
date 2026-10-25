import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { extractVariables, renderTemplate } from '../public/prompt-utils.js';

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prompt-library-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  const create = () => createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { modelCalls += 1; throw new Error('Must not call model'); } });
  const url = await listen(t, create());
  async function call(route, method = 'GET', body, headers = {}) {
    const response = await fetch(url + route, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers } } : { headers }) });
    return { status: response.status, data: await response.json() };
  }
  return { directory, url, create, call, modelCalls: () => modelCalls, input: { name: '评测题构建', category: '题目生成', description: '基于专家意见构建题目', content: '请基于{{参考资料}}生成{{题目数量}}道题。\r\n再次确认{{ 题目数量 }}。\r\n返回 JSON。' } };
}

test('变量识别支持中文、重复、空白，保持首次出现顺序', () => {
  assert.deepEqual(extractVariables('{{主题}} {{ count }} {{主题}} {{参考.数据}} {{a-b}} {{_值}}'), ['主题', 'count', '参考.数据', 'a-b', '_值']);
  assert.deepEqual(extractVariables('{普通JSON} {{不含 空格}} {{ }}'), []);
});

test('替换保留字面文本和换行，不执行或递归解释变量值', () => {
  const output = renderTemplate('原文{{主题}}，数量{{数量}}；{{ 主题 }}', { 主题: '<script>alert(1)</script> $& $$\n{{数量}}', 数量: '20' });
  assert.equal(output.text, '原文<script>alert(1)</script> $& $$\n{{数量}}，数量20；<script>alert(1)</script> $& $$\n{{数量}}');
  assert.deepEqual(output.missingVariables, []);
});

test('缺失变量保持占位符，不读取继承属性，支持合法同名原型字段', () => {
  assert.deepEqual(renderTemplate('A{{主题}} B{{数量}}', { 主题: '   ', 数量: 20 }), { text: 'A{{主题}} B{{数量}}', missingVariables: ['主题', '数量'] });
  assert.deepEqual(renderTemplate('{{constructor}} {{__proto__}}').missingVariables, ['constructor', '__proto__']);
  const supplied = Object.fromEntries([['constructor', '普通文本'], ['__proto__', '也是文本']]);
  assert.equal(renderTemplate('{{constructor}} {{__proto__}}', supplied).text, '普通文本 也是文本');
  assert.equal(renderTemplate('没有变量').text, '没有变量');
});

test('模板添加、读取与服务重启恢复，正文和变量精确保留且不调用模型', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/prompts')).data, { templates: [] });
  const saved = await f.call('/api/prompts', 'POST', f.input);
  assert.equal(saved.status, 201);
  assert.equal(saved.data.template.content, f.input.content);
  assert.deepEqual(saved.data.template.variables, ['参考资料', '题目数量']);
  assert.equal(saved.data.template.revision, 1);
  const restarted = await listen(t, f.create());
  const list = await (await fetch(restarted + '/api/prompts')).json();
  assert.equal(list.templates.length, 1);
  assert.equal(list.templates[0].content, f.input.content);
  assert.equal((await f.call('/api/prompts/' + saved.data.template.id)).data.template.name, f.input.name);
  assert.equal(f.modelCalls(), 0);
});

test('长中文正文超过普通配置请求大小仍可保存，未分类模板可直接使用', async t => {
  const f = await fixture(t);
  const content = '专家意见'.repeat(10000);
  const saved = await f.call('/api/prompts', 'POST', { ...f.input, content, category: '', description: '' });
  assert.equal(saved.status, 201);
  assert.equal(saved.data.template.content, content);
  assert.equal(saved.data.template.category, '未分类');
  assert.deepEqual(saved.data.template.variables, []);
});

test('编辑覆盖指定模板，旧版本编辑与删除均被拦截', async t => {
  const f = await fixture(t);
  const original = (await f.call('/api/prompts', 'POST', f.input)).data.template;
  const body = { ...f.input, revision: original.revision, content: '修改后的正文 {{主题}}' };
  const updated = await f.call('/api/prompts/' + original.id, 'PUT', body);
  assert.equal(updated.status, 200);
  assert.equal(updated.data.template.revision, 2);
  assert.deepEqual(updated.data.template.variables, ['主题']);
  assert.equal((await f.call('/api/prompts/' + original.id, 'PUT', body)).status, 409);
  assert.equal((await f.call('/api/prompts/' + original.id, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await f.call('/api/prompts/' + original.id)).data.template.content, body.content);
});

test('并发添加不会丢失，重复模板名被拒绝', async t => {
  const f = await fixture(t);
  const saved = await Promise.all([0, 1, 2, 3].map(index => f.call('/api/prompts', 'POST', { ...f.input, name: '模板' + index })));
  assert.ok(saved.every(result => result.status === 201));
  assert.equal((await f.call('/api/prompts')).data.templates.length, 4);
  assert.equal((await f.call('/api/prompts', 'POST', { ...f.input, name: '模板0' })).status, 409);
});

test('删除模板不再列出，归档记录保留且同名可重新添加', async t => {
  const f = await fixture(t);
  const original = (await f.call('/api/prompts', 'POST', f.input)).data.template;
  assert.equal((await f.call('/api/prompts/' + original.id, 'DELETE', { revision: original.revision })).status, 200);
  assert.equal((await f.call('/api/prompts')).data.templates.length, 0);
  assert.equal((await f.call('/api/prompts/' + original.id)).status, 404);
  const store = JSON.parse(await readFile(path.join(f.directory, 'prompts.json'), 'utf8'));
  assert.ok(store.templates[0].deletedAt);
  assert.equal(store.templates[0].content, f.input.content);
  assert.equal((await f.call('/api/prompts', 'POST', f.input)).status, 201);
});

test('拒绝无效输入、空正文与过多变量，HTTP 仅接受同源 JSON', async t => {
  const f = await fixture(t);
  for (const change of [{ name: ' ' }, { name: 'x'.repeat(101) }, { category: 'a'.repeat(41) }, { description: 'a'.repeat(301) }, { content: ' \n ' }, { content: 'x'.repeat(50001) }, { content: Array.from({ length: 101 }, (_, i) => '{{变量' + i + '}}').join(' ') }]) {
    assert.equal((await f.call('/api/prompts', 'POST', { ...f.input, ...change })).status, 400);
  }
  assert.equal((await f.call('/api/prompts', 'POST', f.input, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.call('/api/prompts', 'POST', f.input, { 'Content-Type': 'text/plain' })).status, 415);
  const oversized = await f.call('/api/prompts', 'POST', { ...f.input, ignored: 'x'.repeat(270 * 1024) });
  assert.equal(oversized.status, 413);
});

test('损坏的提示词库不覆盖，静态路径不能读取模板存储文件', async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, 'prompts.json'), 'corrupt-original-data');
  assert.equal((await f.call('/api/prompts')).status, 500);
  assert.equal((await f.call('/api/prompts', 'POST', f.input)).status, 500);
  assert.equal(await readFile(path.join(f.directory, 'prompts.json'), 'utf8'), 'corrupt-original-data');
  assert.equal((await fetch(f.url + '/data/prompts.json')).status, 404);
  assert.equal((await fetch(f.url + '/prompts')).status, 200);
});
