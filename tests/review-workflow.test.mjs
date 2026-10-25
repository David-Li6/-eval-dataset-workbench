import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';

const sample = n => ({ Question: '完整问题' + n, 'User Question': '用户问题' + n, 'SELECT Data': n === 1 ? null : { 报价: 685 }, answer: '答案' + n, 'Scoring criteria': { 满分: 5, 得分点: [{ 分值: 5, 标准: '准确回答' }] }, difficulty: '易', 'Task family': 'A 点查', source: 'IO-' + n, extra: { flag: false, count: 0 } });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-workflow-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const create = () => createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { calls += 1; throw new Error('No model call expected'); } });
  async function start() {
    const server = create(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  const request = async (route, method = 'GET', body, origin = url, headers = {}) => {
    const response = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const upload = async (items = [sample(1), sample(2), sample(3)]) => {
    const result = await request('/api/technical-reviews?name=' + encodeURIComponent('评测集.json'), 'POST', { questions: items }); assert.equal(result.status, 201); return result.data.dataset;
  };
  const version = async name => { const result = await request('/api/frozen-versions', 'POST', { name, description: '测试版本说明' }); assert.equal(result.status, 201); return result.data.version; };
  const questionRoute = (dataset, number = 1) => '/api/technical-reviews/' + dataset.id + '/questions/' + number;
  return { directory, url, request, upload, version, start, questionRoute, calls: () => calls };
}

test('冻结版本可创建、切换与重启恢复，空版本可查看并导出', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/frozen-versions')).data.versions, []);
  const v1 = await f.version('V1'); const v2 = await f.version('V2');
  const restarted = await f.start();
  const list = (await f.request('/api/frozen-versions', 'GET', undefined, restarted)).data.versions;
  assert.deepEqual(list.map(v => v.id), [v2.id, v1.id]);
  assert.equal(list[0].questionCount, 0);
  assert.equal((await f.request('/api/frozen-versions/' + v1.id + '/questions')).data.total, 0);
  assert.deepEqual((await f.request('/api/frozen-versions/' + v1.id + '/download')).data, []);
  assert.equal((await f.request('/api/frozen-versions/' + v1.id + '/questions/1')).status, 404);
});

test('修改完整字段并更新列表、搜索和统计，原始上传文件保持不变', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const route = f.questionRoute(dataset);
  const original = (await f.request('/api/technical-reviews/' + dataset.id + '/download')).data;
  const before = (await f.request(route)).data;
  const record = { ...before.record, 'User Question': '更新后的自然提问', answer: '新答案', difficulty: '难', 'Task family': '比较', 'Scoring criteria': { 满分: 10, 细则: [null, 0, false, { 要点: '完整' }] } };
  const saved = await f.request(route, 'PUT', { revision: before.summary.revision, record });
  assert.equal(saved.status, 200); assert.deepEqual(saved.data.record, record); assert.notEqual(saved.data.summary.revision, before.summary.revision);
  assert.equal(saved.data.summary.status, 'pending');
  const list = (await f.request('/api/technical-reviews/' + dataset.id + '/questions?query=' + encodeURIComponent('新答案'))).data;
  assert.equal(list.total, 1); assert.equal(list.questions[0].difficulty, '难'); assert.equal(list.dataset.families['比较'], 1);
  const restarted = await f.start();
  assert.deepEqual((await f.request(route, 'GET', undefined, restarted)).data.record, record);
  assert.deepEqual((await f.request('/api/technical-reviews/' + dataset.id + '/download')).data, original);
});

test('删除后保留其余原序号，详情跳过删除项；全部删除后列表与统计仍可读取', async t => {
  const f = await fixture(t); const dataset = await f.upload();
  assert.equal((await f.request(f.questionRoute(dataset, 2), 'DELETE', { revision: 'original' })).status, 200);
  const list = (await f.request('/api/technical-reviews/' + dataset.id + '/questions')).data;
  assert.deepEqual(list.questions.map(q => q.number), [1, 3]); assert.equal(list.dataset.deletedCount, 1); assert.equal(list.dataset.questionCount, 2);
  assert.equal((await f.request(f.questionRoute(dataset, 2))).status, 404);
  assert.deepEqual((await f.request(f.questionRoute(dataset))).data.navigation, { previous: null, next: 3, position: 1, total: 2 });
  await f.request(f.questionRoute(dataset), 'DELETE', { revision: 'original' }); await f.request(f.questionRoute(dataset, 3), 'DELETE', { revision: 'original' });
  const empty = (await f.request('/api/technical-reviews/' + dataset.id + '/questions')).data;
  assert.equal(empty.total, 0); assert.equal(empty.dataset.pendingCount, 0); assert.equal(empty.dataset.deletedCount, 3);
  const restarted = await f.start(); assert.equal((await f.request('/api/technical-reviews', 'GET', undefined, restarted)).data.datasets[0].questionCount, 0);
});

test('通过后只加入所选版本，并同步审核状态和待审核筛选，不调用模型', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const v1 = await f.version('v1'); const v2 = await f.version('v2');
  const passed = await f.request(f.questionRoute(dataset) + '/approve', 'POST', { revision: 'original', versionId: v2.id });
  assert.equal(passed.status, 200); assert.equal(passed.data.summary.status, 'approved'); assert.equal(passed.data.dataset.approvedCount, 1); assert.equal(passed.data.dataset.pendingCount, 2);
  assert.deepEqual(passed.data.summary.approvedVersions, [{ id: v2.id, name: v2.name }]);
  assert.equal((await f.request('/api/frozen-versions/' + v1.id + '/questions')).data.total, 0);
  const frozen = (await f.request('/api/frozen-versions/' + v2.id + '/questions/1')).data;
  assert.deepEqual(frozen.record, sample(1)); assert.equal(frozen.summary.origin.number, 1); assert.equal(frozen.summary.origin.datasetId, dataset.id);
  assert.deepEqual((await f.request('/api/technical-reviews/' + dataset.id + '/questions?status=pending')).data.questions.map(q => q.number), [2, 3]);
  assert.equal((await f.request('/api/technical-reviews/' + dataset.id + '/questions?status=approved')).data.total, 1);
  assert.equal(f.calls(), 0);
});

test('冻结内容不随后续修改改变，新内容可加入其他版本；同版本不重复收录或覆盖', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const v1 = await f.version('第一版'); const v2 = await f.version('第二版'); const route = f.questionRoute(dataset);
  await f.request(route + '/approve', 'POST', { revision: 'original', versionId: v1.id });
  assert.equal((await f.request(route + '/approve', 'POST', { revision: 'original', versionId: v1.id })).status, 409);
  const changed = { ...sample(1), answer: '新修订答案', 'SELECT Data': { 新数据: [0, false, null] } };
  const edited = (await f.request(route, 'PUT', { revision: 'original', record: changed })).data;
  assert.equal(edited.summary.status, 'pending'); assert.equal(edited.dataset.approvedCount, 0); assert.equal(edited.summary.frozenVersions[0].id, v1.id);
  assert.equal((await f.request(route + '/approve', 'POST', { revision: edited.summary.revision, versionId: v1.id })).status, 409);
  assert.deepEqual((await f.request('/api/frozen-versions/' + v1.id + '/questions/1')).data.record, sample(1));
  assert.equal((await f.request(route + '/approve', 'POST', { revision: edited.summary.revision, versionId: v2.id })).status, 200);
  assert.deepEqual((await f.request('/api/frozen-versions/' + v2.id + '/questions/1')).data.record, changed);
});

test('审核区删除后冻结版本仍可重启查看，导出只有题目字段和原顺序', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const version = await f.version('已验收版本');
  for (const number of [3, 1]) await f.request(f.questionRoute(dataset, number) + '/approve', 'POST', { revision: 'original', versionId: version.id });
  await f.request(f.questionRoute(dataset), 'DELETE', { revision: 'original' });
  const restarted = await f.start();
  const download = await fetch(restarted + '/api/frozen-versions/' + version.id + '/download');
  assert.equal(download.status, 200); assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('已验收版本.json')));
  assert.deepEqual(await download.json(), [sample(3), sample(1)]);
  const list = (await f.request('/api/frozen-versions/' + version.id + '/questions?query=' + encodeURIComponent('用户问题1'), 'GET', undefined, restarted)).data;
  assert.equal(list.questions[0].number, 2); assert.equal(list.questions[0].origin.number, 1);
});

test('旧版本编辑、删除和通过被拦截，并发修改只有一次成功', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const v = await f.version('并发版本'); const route = f.questionRoute(dataset);
  const results = await Promise.all([f.request(route, 'PUT', { revision: 'original', record: sample(7) }), f.request(route, 'PUT', { revision: 'original', record: sample(8) })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  for (const [method, suffix, body] of [['PUT', '', { record: sample(9) }], ['DELETE', '', {}], ['POST', '/approve', { versionId: v.id }]]) assert.equal((await f.request(route + suffix, method, { ...body, revision: 'original' })).status, 409);
  assert.equal((await f.request(route, 'DELETE', {})).status, 409);
});

test('并发通过在同版本中去重，不同版本分别收录', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const v1 = await f.version('并发1'); const v2 = await f.version('并发2'); const route = f.questionRoute(dataset) + '/approve';
  const repeated = await Promise.all([f.request(route, 'POST', { revision: 'original', versionId: v1.id }), f.request(route, 'POST', { revision: 'original', versionId: v1.id })]);
  assert.deepEqual(repeated.map(r => r.status).sort(), [200, 409]);
  assert.equal((await f.request(route, 'POST', { revision: 'original', versionId: v2.id })).status, 200);
  assert.equal((await f.request(f.questionRoute(dataset))).data.summary.approvedVersions.length, 2);
  const two = await Promise.all([f.request('/api/frozen-versions', 'POST', { name: '并行创建' }), f.request('/api/frozen-versions', 'POST', { name: '并行创建' })]);
  assert.deepEqual(two.map(r => r.status).sort(), [201, 409]);
});

test('校验版本名称、非法题目、缺失字段、跨站和不存在版本，不写入错误内容', async t => {
  const f = await fixture(t); const dataset = await f.upload([{ Question: '缺答案' }]); const route = f.questionRoute(dataset); const v = await f.version('V1');
  for (const name of ['', ' ', 'x'.repeat(81), 'bad\nname']) assert.equal((await f.request('/api/frozen-versions', 'POST', { name })).status, 400);
  assert.equal((await f.request('/api/frozen-versions', 'POST', { name: 'v1' })).status, 409);
  assert.equal((await f.request('/api/frozen-versions', 'POST', { name: '正常', description: 'x'.repeat(501) })).status, 400);
  for (const record of [null, [], 'invalid']) assert.equal((await f.request(route, 'PUT', { revision: 'original', record })).status, 400);
  assert.equal((await f.request(route + '/approve', 'POST', { revision: 'original', versionId: v.id })).data.error.code, 'INCOMPLETE_QUESTION');
  assert.equal((await f.request(route + '/approve', 'POST', { revision: 'original', versionId: '00000000-0000-0000-0000-000000000000' })).status, 404);
  assert.equal((await f.request(route, 'DELETE', { revision: 'original' }, f.url, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(route, 'PUT', { revision: 'original', record: sample(1) }, f.url, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await fetch(f.url + '/data/technical-reviews/workflow.json')).status, 404);
  assert.equal((await f.request('/api/technical-reviews/' + dataset.id + '/download/1')).status, 404);
  const repaired = (await f.request(route, 'PUT', { revision: 'original', record: sample(1) })).data;
  assert.equal((await f.request(route + '/approve', 'POST', { revision: repaired.summary.revision, versionId: v.id })).status, 200);
  assert.equal((await fetch(f.url + '/frozen-datasets')).status, 200);
});

test('审核记录损坏时拒绝覆盖，已有原题与版本文件保留', async t => {
  const f = await fixture(t); const dataset = await f.upload(); await f.version('已有版本');
  const filename = path.join(f.directory, 'technical-reviews', 'workflow.json'); const content = await readFile(filename, 'utf8');
  await writeFile(filename, 'broken original');
  assert.equal((await f.request('/api/frozen-versions', 'POST', { name: '新版本' })).status, 500);
  assert.equal((await f.request(f.questionRoute(dataset), 'DELETE', { revision: 'original' })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), 'broken original');
  await writeFile(filename, content);
  assert.equal((await f.request('/api/frozen-versions')).data.versions.length, 1);
  assert.deepEqual((await f.request(f.questionRoute(dataset))).data.record, sample(1));
});

test('删除冻结版本后隐藏版本及快照入口，保留原题、其他版本和本机归档', async t => {
  const f = await fixture(t); const dataset = await f.upload();
  const first = await f.version('删除版本'); const second = await f.version('保留版本');
  const route = f.questionRoute(dataset);
  await f.request(route + '/approve', 'POST', { revision: 'original', versionId: first.id });
  await f.request(route + '/approve', 'POST', { revision: 'original', versionId: second.id });
  await f.request(f.questionRoute(dataset, 2) + '/approve', 'POST', { revision: 'original', versionId: first.id });
  const versions = (await f.request('/api/frozen-versions')).data.versions;
  const selected = versions.find(version => version.id === first.id);
  const removed = await f.request('/api/frozen-versions/' + first.id, 'DELETE', { revision: selected.revision });
  assert.equal(removed.status, 200); assert.equal(removed.data.version.questionCount, 2);
  const restarted = await f.start();
  assert.deepEqual((await f.request('/api/frozen-versions', 'GET', undefined, restarted)).data.versions.map(version => version.id), [second.id]);
  for (const suffix of ['', '/questions', '/questions/1', '/download']) assert.equal((await f.request('/api/frozen-versions/' + first.id + suffix)).status, 404);
  assert.equal((await f.request(route + '/approve', 'POST', { revision: 'original', versionId: first.id })).status, 404);
  const retained = (await f.request(route)).data;
  assert.deepEqual(retained.record, sample(1)); assert.equal(retained.summary.status, 'approved');
  assert.deepEqual(retained.summary.approvedVersions, [{ id: second.id, name: second.name }]);
  assert.equal((await f.request(f.questionRoute(dataset, 2))).data.summary.status, 'pending');
  assert.deepEqual((await f.request('/api/frozen-versions/' + second.id + '/download')).data, [sample(1)]);
  assert.deepEqual((await f.request('/api/technical-reviews/' + dataset.id + '/download')).data.questions, [sample(1), sample(2), sample(3)]);
  const store = JSON.parse(await readFile(path.join(f.directory, 'technical-reviews', 'workflow.json'), 'utf8'));
  const archived = store.versions.find(version => version.id === first.id);
  assert.ok(archived.deletedAt); assert.deepEqual(archived.questions.map(item => item.record), [sample(1), sample(2)]);
  assert.notEqual((await f.version(first.name)).id, first.id);
  assert.equal(f.calls(), 0);
});

test('删除最后一个空版本后可重新创建；旧格式无修订号版本也能正常删除', async t => {
  const f = await fixture(t); const created = await f.version('旧版本');
  const filename = path.join(f.directory, 'technical-reviews', 'workflow.json');
  const store = JSON.parse(await readFile(filename, 'utf8')); delete store.versions[0].revision;
  await writeFile(filename, JSON.stringify(store));
  const legacy = (await f.request('/api/frozen-versions')).data.versions[0];
  assert.ok(legacy.revision);
  assert.equal((await f.request('/api/frozen-versions/' + created.id, 'DELETE', { revision: legacy.revision })).status, 200);
  assert.deepEqual((await f.request('/api/frozen-versions')).data.versions, []);
  assert.equal((await f.request('/api/frozen-versions/' + created.id, 'DELETE', { revision: legacy.revision })).status, 404);
  assert.ok((await f.version(created.name)).id);
});

test('删除检查版本修订，新增题目后的旧确认及并发收录不会误删更新内容', async t => {
  const f = await fixture(t); const dataset = await f.upload(); const version = await f.version('并发删除');
  const route = '/api/frozen-versions/' + version.id;
  assert.equal((await f.request(route, 'DELETE', {})).status, 409);
  await f.request(f.questionRoute(dataset) + '/approve', 'POST', { revision: 'original', versionId: version.id });
  const stale = await f.request(route, 'DELETE', { revision: version.revision });
  assert.equal(stale.status, 409); assert.equal(stale.data.error.code, 'VERSION_CONFLICT');
  assert.equal((await f.request(route + '/questions')).data.total, 1);
  const fresh = (await f.request('/api/frozen-versions')).data.versions[0];
  const concurrent = await Promise.all([
    f.request(route, 'DELETE', { revision: fresh.revision }),
    f.request(f.questionRoute(dataset, 2) + '/approve', 'POST', { revision: 'original', versionId: version.id })
  ]);
  assert.equal(concurrent.filter(result => result.status === 200).length, 1);
  if (concurrent[0].status === 200) assert.equal(concurrent[1].status, 404);
  else { assert.equal(concurrent[0].status, 409); assert.equal((await f.request(route + '/questions')).data.total, 2); }
});

test('删除版本拒绝跨站、错误格式和损坏存储，失败不改动已有数据', async t => {
  const f = await fixture(t); const version = await f.version('保留原件'); const route = '/api/frozen-versions/' + version.id;
  const filename = path.join(f.directory, 'technical-reviews', 'workflow.json'), original = await readFile(filename, 'utf8');
  assert.equal((await f.request(route, 'DELETE', { revision: version.revision }, f.url, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(route, 'DELETE', { revision: version.revision }, f.url, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(route + '/download', 'DELETE', { revision: version.revision })).status, 404);
  assert.equal(await readFile(filename, 'utf8'), original);
  await writeFile(filename, 'broken original');
  assert.equal((await f.request(route, 'DELETE', { revision: version.revision })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), 'broken original');
});

test('冻结表头使用版本首次收录题目的实际 key 和顺序，跨页搜索不改变，额外字段仍保留于详情和导出', async t => {
  const f = await fixture(t);
  const records = [{ id: '第一题', question: '首题', answer: 0, flag: false, data: null }, { answer: '次题答案', question: '第二题', 独有字段: { 内容: '额外数据' } }];
  const dataset = await f.upload(records), version = await f.version('动态表头');
  for (const number of [1, 2]) assert.equal((await f.request(f.questionRoute(dataset, number) + '/approve', 'POST', { revision: 'original', versionId: version.id })).status, 200);
  const route = '/api/frozen-versions/' + version.id;
  for (const suffix of ['/questions', '/questions?pageSize=1&page=2', '/questions?query=' + encodeURIComponent('额外数据')]) {
    const result = (await f.request(route + suffix)).data;
    assert.deepEqual(result.dataset.fieldNames, Object.keys(records[0]));
    assert.equal(result.dataset.fieldCount, 5);
    assert.ok(result.questions.every(item => item.fieldPreviews.length));
  }
  assert.deepEqual((await f.request(route + '/questions/2')).data.record, records[1]);
  assert.deepEqual((await f.request(route + '/download')).data, records);
  const other = await f.version('另一个结构');
  await f.request(f.questionRoute(dataset, 2) + '/approve', 'POST', { revision: 'original', versionId: other.id });
  assert.deepEqual((await f.request('/api/frozen-versions/' + other.id + '/questions')).data.dataset.fieldNames, Object.keys(records[1]));
});

test('删除冻结题目持久化、保持其余序号和首题表头，更新导出及审核状态，保留其他版本和原文件', async t => {
  const f = await fixture(t), dataset = await f.upload(), version = await f.version('删除单题'), other = await f.version('保留快照');
  for (const number of [1, 2, 3]) await f.request(f.questionRoute(dataset, number) + '/approve', 'POST', { revision: 'original', versionId: version.id });
  await f.request(f.questionRoute(dataset) + '/approve', 'POST', { revision: 'original', versionId: other.id });
  const route = '/api/frozen-versions/' + version.id;
  const remove = async number => { const meta = (await f.request(route)).data.dataset; return f.request(route + '/questions/' + number, 'DELETE', { revision: meta.revision }); };
  const removed = await remove(1); assert.equal(removed.status, 200); assert.equal(removed.data.dataset.questionCount, 2);
  assert.equal((await f.request(f.questionRoute(dataset))).data.summary.status, 'approved');
  assert.equal((await f.request(route + '/questions/1')).status, 404);
  assert.deepEqual((await f.request(route + '/questions')).data.questions.map(item => item.number), [2, 3]);
  assert.deepEqual((await f.request(route + '/questions/2')).data.navigation, { previous: null, next: 3, position: 1, total: 2 });
  const technicalBefore = (await f.request('/api/technical-reviews/' + dataset.id)).data.dataset;
  await remove(2);
  const technicalAfter = (await f.request('/api/technical-reviews/' + dataset.id)).data.dataset;
  assert.notEqual(technicalBefore.revision, technicalAfter.revision);
  assert.equal((await f.request(f.questionRoute(dataset, 2))).data.summary.status, 'pending');
  const restarted = await f.start();
  assert.deepEqual((await f.request(route + '/download', 'GET', undefined, restarted)).data, [sample(3)]);
  assert.deepEqual((await f.request('/api/frozen-versions/' + other.id + '/download')).data, [sample(1)]);
  assert.deepEqual((await f.request('/api/technical-reviews/' + dataset.id + '/download')).data.questions, [sample(1), sample(2), sample(3)]);
  await remove(3);
  const empty = (await f.request(route + '/questions')).data;
  assert.equal(empty.total, 0); assert.deepEqual(empty.dataset.fieldNames, Object.keys(sample(1)));
  assert.deepEqual((await f.request(route + '/download')).data, []);
  // Removed records are archived, and the same source question can be reviewed into the version again.
  const store = JSON.parse(await readFile(path.join(f.directory, 'technical-reviews', 'workflow.json'), 'utf8'));
  assert.ok(store.versions.find(item => item.id === version.id).questions.every(item => item.deletedAt));
  assert.equal((await f.request(f.questionRoute(dataset, 2) + '/approve', 'POST', { revision: 'original', versionId: version.id })).status, 200);
  assert.deepEqual((await f.request(route + '/questions')).data.questions.map(item => item.number), [4]);
  assert.deepEqual((await f.request(route + '/download')).data, [sample(2)]);
  assert.equal(f.calls(), 0);
});

test('冻结单题删除检查版本修订和并发，拒绝过期确认、非法题号、跨站请求和损坏文件', async t => {
  const f = await fixture(t), dataset = await f.upload(), version = await f.version('并发单题删除');
  const route = '/api/frozen-versions/' + version.id;
  await f.request(f.questionRoute(dataset) + '/approve', 'POST', { revision: 'original', versionId: version.id });
  const stale = (await f.request(route)).data.dataset;
  await f.request(f.questionRoute(dataset, 2) + '/approve', 'POST', { revision: 'original', versionId: version.id });
  assert.equal((await f.request(route + '/questions/1', 'DELETE', { revision: stale.revision })).status, 409);
  const fresh = (await f.request(route)).data.dataset;
  const filename = path.join(f.directory, 'technical-reviews', 'workflow.json'), original = await readFile(filename, 'utf8');
  for (const [suffix, body, headers, expected] of [['/questions/0', { revision: fresh.revision }, {}, 400], ['/questions/99', { revision: fresh.revision }, {}, 404], ['/questions/1', {}, {}, 409], ['/questions/1', { revision: fresh.revision }, { Origin: 'https://other.example' }, 403], ['/questions/1', { revision: fresh.revision }, { 'Content-Type': 'text/plain' }, 415]]) assert.equal((await f.request(route + suffix, 'DELETE', body, f.url, headers)).status, expected);
  assert.equal(await readFile(filename, 'utf8'), original);
  const concurrent = await Promise.all([1, 2].map(number => f.request(route + '/questions/' + number, 'DELETE', { revision: fresh.revision })));
  assert.deepEqual(concurrent.map(result => result.status).sort(), [200, 409]);
  const current = (await f.request(route + '/questions')).data;
  assert.equal(current.total, 1);
  const removedNumber = concurrent[0].status === 200 ? 1 : 2;
  assert.equal((await f.request(route + '/questions/' + removedNumber, 'DELETE', { revision: current.dataset.revision })).status, 404);
  const restored = await readFile(filename, 'utf8'); await writeFile(filename, 'broken original');
  assert.equal((await f.request(route + '/questions/' + current.questions[0].number, 'DELETE', { revision: current.dataset.revision })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), 'broken original');
  await writeFile(filename, restored);
  assert.equal((await f.request(route + '/questions')).data.total, 1);
});
