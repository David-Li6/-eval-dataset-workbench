import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';

const sample = number => ({ Question: '完整题目' + number, 'User Question': '用户提问' + number, 'SELECT Data': null, answer: '答案' + number, 'Scoring criteria': { 满分: 5, 细则: [false, 0, null, { 内容: '完整' }] }, difficulty: number % 2 ? '易' : '难', 'Task family': number % 3 ? 'A 点查' : 'C 对比', source: 'IO-' + number });
async function fixture(t, records = Array.from({ length: 45 }, (_, i) => sample(i + 1))) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createAppServer({ configPath: path.join(directory, 'config.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = 'http://127.0.0.1:' + server.address().port;
  const request = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch(url + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const dataset = (await request('/api/technical-reviews?name=batch.json', 'POST', records)).data.dataset;
  const route = '/api/technical-reviews/' + dataset.id;
  const createVersion = async name => (await request('/api/frozen-versions', 'POST', { name })).data.version;
  const choose = async filters => (await request(route + '/selection' + (filters ? '?' + new URLSearchParams(filters) : ''))).data.questions.map(({ number, revision }) => ({ number, revision }));
  const batch = (action, questions, versionId) => request(route + '/batch', 'POST', { action, questions, versionId });
  return { directory, request, route, dataset, choose, batch, createVersion };
}

test('全选接口返回跨页筛选结果，保留题号和修订号，与列表筛选一致', async t => {
  const f = await fixture(t);
  const all = (await f.request(f.route + '/selection')).data;
  assert.equal(all.questions.length, 45); assert.equal(all.questions.at(-1).number, 45);
  assert.ok(all.questions.every(item => item.revision === 'original' && !Object.hasOwn(item, 'searchText')));
  const filters = { difficulty: '难', family: 'C 对比', status: 'pending' };
  const selected = await f.choose(filters);
  const listed = (await f.request(f.route + '/questions?' + new URLSearchParams(filters))).data;
  assert.deepEqual(selected.map(q => q.number), [6, 12, 18, 24, 30, 36, 42]);
  assert.deepEqual(selected.map(q => q.number), listed.questions.map(q => q.number));
  assert.deepEqual(await f.choose({ query: 'not-existing' }), []);
  assert.equal((await f.request(f.route + '/selection?status=invalid')).status, 400);
});

test('批量通过按原题顺序加入指定版本，数据类型与全部字段保留', async t => {
  const f = await fixture(t); const version = await f.createVersion('批量通过 v1'); const other = await f.createVersion('其他版本');
  const selected = [45, 1, 21].map(number => ({ number, revision: 'original' }));
  const passed = await f.batch('approve', selected, version.id);
  assert.equal(passed.status, 200); assert.equal(passed.data.affectedCount, 3); assert.deepEqual(passed.data.numbers, [1, 21, 45]);
  assert.equal(passed.data.dataset.approvedCount, 3); assert.equal(passed.data.dataset.pendingCount, 42);
  assert.deepEqual((await f.request('/api/frozen-versions/' + version.id + '/download')).data, [sample(1), sample(21), sample(45)]);
  assert.equal((await f.request('/api/frozen-versions/' + other.id + '/questions')).data.total, 0);
  assert.deepEqual((await f.choose({ status: 'approved' })).map(item => item.number), [1, 21, 45]);
});

test('跨页全选批量删除，原始文件和冻结快照保留，全部删除后的统计正确', async t => {
  const f = await fixture(t); const version = await f.createVersion('保留的冻结版本');
  const original = (await f.request(f.route + '/download')).data;
  await f.batch('approve', [{ number: 21, revision: 'original' }], version.id);
  const deleted = await f.batch('delete', await f.choose());
  assert.equal(deleted.status, 200); assert.equal(deleted.data.affectedCount, 45); assert.equal(deleted.data.dataset.deletedCount, 45);
  assert.equal(deleted.data.dataset.questionCount, 0); assert.equal(deleted.data.dataset.approvedCount, 0);
  assert.deepEqual(await f.choose(), []); assert.equal((await f.request(f.route + '/questions')).data.total, 0);
  assert.deepEqual((await f.request(f.route + '/download')).data, original);
  assert.deepEqual((await f.request('/api/frozen-versions/' + version.id + '/download')).data, [sample(21)]);
});

test('任一题修订号过期或已删除时整批不执行，其他题不会被误删或收录', async t => {
  const f = await fixture(t); const version = await f.createVersion('冲突测试'); const selected = await f.choose();
  const edited = await f.request(f.route + '/questions/21', 'PUT', { revision: 'original', record: { ...sample(21), answer: '修改后答案' } });
  assert.equal(edited.status, 200);
  for (const action of ['delete', 'approve']) {
    const result = await f.batch(action, selected, version.id);
    assert.equal(result.status, 409); assert.ok(result.data.error.message.includes('第 21 题'));
    assert.equal((await f.request(f.route + '/questions')).data.total, 45);
    assert.equal((await f.request('/api/frozen-versions/' + version.id + '/questions')).data.total, 0);
  }
  await f.request(f.route + '/questions/45', 'DELETE', { revision: 'original' });
  assert.equal((await f.batch('delete', [{ number: 1, revision: 'original' }, { number: 45, revision: 'original' }])).status, 409);
  assert.equal((await f.request(f.route + '/questions/1')).status, 200);
});

test('批量包含缺失字段或版本重复题时不部分写入，修复后可整批通过', async t => {
  const f = await fixture(t, [sample(1), { Question: '缺少答案' }, sample(3)]); const version = await f.createVersion('字段检查');
  const failed = await f.batch('approve', await f.choose(), version.id);
  assert.equal(failed.status, 400); assert.equal(failed.data.error.code, 'INCOMPLETE_QUESTION');
  assert.equal((await f.request('/api/frozen-versions/' + version.id + '/questions')).data.total, 0);
  await f.request(f.route + '/questions/2', 'PUT', { revision: 'original', record: sample(2) });
  await f.batch('approve', [{ number: 1, revision: 'original' }], version.id);
  const repeated = await f.batch('approve', await f.choose(), version.id);
  assert.equal(repeated.status, 409); assert.equal(repeated.data.error.code, 'QUESTION_ALREADY_FROZEN');
  assert.equal((await f.request('/api/frozen-versions/' + version.id + '/questions')).data.total, 1);
  const other = await f.createVersion('完整版本');
  assert.equal((await f.batch('approve', await f.choose(), other.id)).data.affectedCount, 3);
});

test('校验批量动作、空选、重复题号、非法修订号和跨站请求，失败不修改数据', async t => {
  const f = await fixture(t); const valid = [{ number: 1, revision: 'original' }];
  for (const body of [
    { action: 'invalid', questions: valid }, { action: 'delete', questions: [] }, { action: 'delete', questions: [...valid, ...valid] },
    { action: 'delete', questions: [{ number: 0, revision: 'original' }] }, { action: 'delete', questions: [{ number: '1', revision: 'original' }] },
    { action: 'delete', questions: [{ number: 1 }] }, { action: 'delete', questions: Array.from({ length: 10001 }, (_, i) => ({ number: i + 1, revision: 'original' })) }
  ]) assert.equal((await f.request(f.route + '/batch', 'POST', body)).status, 400);
  assert.equal((await f.request(f.route + '/batch', 'POST', { action: 'delete', questions: valid }, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(f.route + '/batch', 'POST', { action: 'delete', questions: valid }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.batch('approve', valid, '00000000-0000-0000-0000-000000000000')).status, 404);
  assert.equal((await f.request(f.route + '/questions')).data.total, 45);
});

test('并发重叠的批量删除只执行一次，重叠批量通过不产生重复快照', async t => {
  const f = await fixture(t); const selected = (await f.choose()).slice(0, 5); const version = await f.createVersion('并发批量');
  const approvals = await Promise.all([f.batch('approve', selected, version.id), f.batch('approve', selected, version.id)]);
  assert.deepEqual(approvals.map(item => item.status).sort(), [200, 409]);
  assert.equal((await f.request('/api/frozen-versions/' + version.id + '/questions')).data.total, 5);
  const deletions = await Promise.all([f.batch('delete', selected), f.batch('delete', selected)]);
  assert.deepEqual(deletions.map(item => item.status).sort(), [200, 409]);
  assert.equal((await f.request(f.route + '/questions')).data.dataset.deletedCount, 5);
  const stored = JSON.parse(await readFile(path.join(f.directory, 'technical-reviews', 'workflow.json'), 'utf8'));
  assert.equal(stored.changes.length, 5); assert.equal(stored.versions[0].questions.length, 5);
});
