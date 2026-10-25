import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
const records = [{ Question: '第一题', answer: '第一题答案' }, { Question: '第二题', answer: '第二题答案' }];
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'delete-review-dataset-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  async function start() {
    const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { calls++; throw new Error('No model calls'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  async function request(route, method = 'GET', body, headers = {}, origin = url) {
    const response = await fetch(origin + route, { method, ...(body === undefined ? { headers } : { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const upload = async () => (await request('/api/technical-reviews?name=dataset.json', 'POST', records)).data.dataset;
  const metadata = async id => (await request('/api/technical-reviews/' + id)).data.dataset;
  return { directory, request, upload, metadata, start, calls: () => calls };
}
test('从任一审核页删除整份评测集后同步隐藏，原件与审核归档保留，冻结快照和同名其他导入不改变', async t => {
  const f = await fixture(t); const first = await f.upload(), second = await f.upload();
  const frozen = (await f.request('/api/frozen-versions', 'POST', { name: '保留快照' })).data.version;
  await f.request('/api/technical-reviews/' + first.id + '/questions/1/approve', 'POST', { revision: 'original', versionId: frozen.id });
  await f.request('/api/expert-reviews/' + first.id + '/questions/2/advice', 'PUT', { questionRevision: 'original', expertRevision: 'none', text: '专家建议保留归档' });
  const directory = path.join(f.directory, 'technical-reviews');
  const original = await readFile(path.join(directory, first.id + '.json'));
  const workflow = await readFile(path.join(directory, 'workflow.json'), 'utf8');
  const current = await f.metadata(first.id);
  const deleted = await f.request('/api/expert-reviews/' + first.id, 'DELETE', { revision: current.revision });
  assert.equal(deleted.status, 200); assert.equal(deleted.data.dataset.questionCount, 2);
  for (const api of ['/api/technical-reviews', '/api/expert-reviews']) {
    assert.deepEqual((await f.request(api)).data.datasets.map(item => item.id), [second.id]);
    for (const suffix of ['', '/questions', '/questions/1', '/selection']) assert.equal((await f.request(api + '/' + first.id + suffix)).status, 404);
  }
  assert.equal((await f.request('/api/technical-reviews/' + first.id + '/download')).status, 404);
  assert.equal((await f.request('/api/technical-reviews/' + first.id + '/questions/1', 'PUT', { revision: 'original', record: records[0] })).status, 404);
  assert.equal((await f.request('/api/expert-reviews/' + first.id + '/questions/2/submit', 'POST', {})).status, 404);
  assert.deepEqual((await f.request('/api/frozen-versions/' + frozen.id + '/download')).data, [records[0]]);
  assert.deepEqual(await readFile(path.join(directory, first.id + '.json')), original);
  assert.equal(await readFile(path.join(directory, 'workflow.json'), 'utf8'), workflow);
  assert.ok(JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')).datasets.find(item => item.id === first.id).deletedAt);
  const restarted = await f.start();
  assert.deepEqual((await f.request('/api/technical-reviews', 'GET', undefined, {}, restarted)).data.datasets.map(item => item.id), [second.id]);
  assert.equal(f.calls(), 0);
});
test('允许删除已删空的最后一份评测集，重启不复现，重新上传使用新的题目与建议记录', async t => {
  const f = await fixture(t); const first = await f.upload();
  for (const number of [1, 2]) await f.request('/api/technical-reviews/' + first.id + '/questions/' + number, 'DELETE', { revision: 'original' });
  const empty = await f.metadata(first.id); assert.equal(empty.questionCount, 0);
  assert.equal((await f.request('/api/technical-reviews/' + first.id, 'DELETE', { revision: empty.revision })).status, 200);
  assert.equal((await f.request('/api/technical-reviews/' + first.id, 'DELETE', { revision: empty.revision })).status, 404);
  const restarted = await f.start();
  assert.deepEqual((await f.request('/api/expert-reviews', 'GET', undefined, {}, restarted)).data.datasets, []);
  const next = await f.upload(); assert.notEqual(next.id, first.id); assert.equal(next.questionCount, 2);
  assert.equal((await f.request('/api/expert-reviews/' + next.id + '/questions/1')).data.expertReview.draft, null);
});
test('题目修改、专家草稿及冻结收录均使旧删除确认失效；并发修改与删除只有一个成功', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const route = '/api/technical-reviews/' + dataset.id;
  assert.equal((await f.request(route, 'DELETE', {})).status, 409);
  const edited = (await f.request(route + '/questions/1', 'PUT', { revision: 'original', record: { ...records[0], answer: '新答案' } })).data;
  assert.equal((await f.request(route, 'DELETE', { revision: dataset.revision })).status, 409);
  await f.request('/api/expert-reviews/' + dataset.id + '/questions/1/advice', 'PUT', { questionRevision: edited.summary.revision, expertRevision: 'none', text: '新草稿' });
  assert.equal((await f.request(route, 'DELETE', { revision: edited.dataset.revision })).status, 409);
  const afterAdvice = await f.metadata(dataset.id);
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '并发测试' })).data.version;
  await f.request(route + '/questions/2/approve', 'POST', { revision: 'original', versionId: version.id });
  assert.equal((await f.request(route, 'DELETE', { revision: afterAdvice.revision })).status, 409);
  const current = await f.metadata(dataset.id);
  const concurrent = await Promise.all([f.request(route, 'DELETE', { revision: current.revision }), f.request(route + '/questions/2', 'PUT', { revision: 'original', record: { ...records[1], answer: '另一页更新' } })]);
  assert.equal(concurrent.filter(result => result.status === 200).length, 1);
  if (concurrent[0].status === 200) assert.equal(concurrent[1].status, 404);
  else { assert.equal(concurrent[0].status, 409); assert.equal((await f.metadata(dataset.id)).questionCount, 2); }
});
test('跨站、错误请求格式及损坏索引或工作流均拒绝删除，不覆盖原文件', async t => {
  const f = await fixture(t); const dataset = await f.upload(), route = '/api/technical-reviews/' + dataset.id;
  const filename = path.join(f.directory, 'technical-reviews', 'index.json'), original = await readFile(filename, 'utf8');
  assert.equal((await f.request(route, 'DELETE', { revision: dataset.revision }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(route, 'DELETE', { revision: dataset.revision }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(route + '/questions', 'DELETE', { revision: dataset.revision })).status, 404);
  assert.equal(await readFile(filename, 'utf8'), original);
  await writeFile(filename, 'broken index');
  assert.equal((await f.request(route, 'DELETE', { revision: dataset.revision })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), 'broken index');
  await writeFile(filename, original);
  await writeFile(path.join(f.directory, 'technical-reviews', 'workflow.json'), 'broken workflow');
  assert.equal((await f.request(route, 'DELETE', { revision: dataset.revision })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), original);
});
