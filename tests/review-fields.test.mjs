import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { fieldCategory } from '../review-fields.mjs';

async function fixture(t, records) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-fields-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  async function start() {
    const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { calls += 1; throw new Error('No model calls'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  async function request(route, method = 'GET', body, origin = url, headers = {}) {
    const response = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const dataset = (await request('/api/technical-reviews?name=fields.json', 'POST', records)).data.dataset;
  const route = '/api/technical-reviews/' + dataset.id;
  async function configure(fields) { const current = (await request(route + '/fields')).data; return request(route + '/fields', 'PUT', { revision: current.revision, fields }); }
  return { directory, start, request, route, dataset, configure, calls: () => calls };
}
const row = n => ({ Question: '问题' + n, answer: '答案' + n, difficulty: n % 2 ? '易' : '难', domain: n % 3 ? '铁矿石' : '钢铁' });
const enable = keys => keys.map(key => ({ key, description: '说明：' + key, filterable: true }));
const params = filters => new URLSearchParams({ fieldFilters: JSON.stringify(filters) });

test('已有冻结版本同步审核字段配置，分类仅使用冻结快照值，描述和多选组合筛选重启后仍有效', async t => {
  const records = Array.from({ length: 46 }, (_, index) => row(index + 1)), f = await fixture(t, records);
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '同步分类' })).data.version;
  const freeze = '/api/frozen-versions/' + version.id;
  await f.request(f.route + '/batch', 'POST', { action: 'approve', versionId: version.id, questions: records.map((_, index) => ({ number: index + 1, revision: 'original' })) });
  const original = (await f.request(freeze + '/download')).data, before = (await f.request(freeze)).data.dataset;
  assert.ok(before.fieldSettings.every(field => !field.filterable));
  assert.equal((await f.request(freeze + '/field-options?field=difficulty')).status, 400);
  await f.configure(enable(['difficulty', 'domain']));
  const fields = (await f.request(freeze + '/fields')).data;
  assert.equal(fields.fields.find(field => field.key === 'difficulty').description, '说明：difficulty');
  assert.equal(fields.fields.find(field => field.key === 'difficulty').filterable, true);
  assert.equal(fields.dataset.revision, before.revision);
  const filters = [{ key: 'difficulty', values: ['易', '难'].map(difficulty => fieldCategory({ difficulty }, 'difficulty').value) }, { key: 'domain', values: [fieldCategory({ domain: '铁矿石' }, 'domain').value] }];
  const expected = records.flatMap((record, index) => record.domain === '铁矿石' ? [index + 1] : []);
  const query = params(filters); query.set('pageSize', '10'); query.set('page', '2');
  const result = (await f.request(freeze + '/questions?' + query)).data;
  assert.equal(result.total, expected.length); assert.deepEqual(result.questions.map(item => item.number), expected.slice(10, 20));
  await f.request(f.route + '/questions/1', 'PUT', { revision: 'original', record: { ...records[0], difficulty: '已修改但未冻结' } });
  const options = (await f.request(freeze + '/field-options?field=difficulty')).data.options;
  assert.deepEqual(options.map(option => option.label).sort(), ['易', '难'].sort());
  const restarted = await f.start();
  assert.equal((await f.request(freeze + '/questions?' + params(filters), 'GET', undefined, restarted)).data.total, expected.length);
  assert.deepEqual((await f.request(freeze + '/download')).data, original);
  await f.configure(enable(['domain']));
  assert.equal((await f.request(freeze + '/questions?' + params(filters))).status, 400);
  assert.equal((await f.request(freeze + '/fields')).data.fields.find(field => field.key === 'difficulty').filterable, false);
  assert.equal(f.calls(), 0);
});

test('冻结分类来源按版本隔离，多来源同名字段可筛选；保留首题字段顺序，删除审核副本后仍可用', async t => {
  const first = { ...row(1), category: null }, second = { ...row(2), category: false, hidden: '只在第二题出现' }, f = await fixture(t, [first]);
  const other = (await f.request('/api/technical-reviews?name=other.json', 'POST', [second])).data.dataset;
  const otherRoute = '/api/technical-reviews/' + other.id;
  await f.request(otherRoute + '/fields', 'PUT', { revision: 'none', fields: [{ key: 'category', description: '业务分类', filterable: true }, { key: 'hidden', description: '', filterable: true }] });
  const unrelated = (await f.request('/api/technical-reviews?name=unrelated.json', 'POST', [row(3)])).data.dataset;
  await f.request('/api/technical-reviews/' + unrelated.id + '/fields', 'PUT', { revision: 'none', fields: enable(['difficulty']) });
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '来源隔离' })).data.version, freeze = '/api/frozen-versions/' + version.id;
  await f.request(f.route + '/questions/1/approve', 'POST', { revision: 'original', versionId: version.id });
  await f.request(otherRoute + '/questions/1/approve', 'POST', { revision: 'original', versionId: version.id });
  const fields = (await f.request(freeze + '/fields')).data;
  assert.deepEqual(fields.fields.map(field => field.key), Object.keys(first));
  assert.equal(fields.fields.find(field => field.key === 'category').filterable, true);
  assert.equal(fields.fields.find(field => field.key === 'difficulty').filterable, false);
  assert.equal((await f.request(freeze + '/field-options?field=hidden')).status, 400);
  assert.deepEqual((await f.request(freeze + '/field-options?field=category')).data.options.map(option => option.type).sort(), ['boolean', 'null']);
  const meta = (await f.request(otherRoute)).data.dataset;
  assert.equal((await f.request(otherRoute, 'DELETE', { revision: meta.revision })).status, 200);
  const restarted = await f.start();
  assert.equal((await f.request(freeze + '/fields', 'GET', undefined, restarted)).data.fields.find(field => field.key === 'category').description, '业务分类');
  assert.equal((await f.request(freeze + '/field-options?field=category', 'GET', undefined, restarted)).data.total, 2);
  assert.equal((await f.request(freeze + '/fields', 'PUT', { revision: fields.revision, fields: [] })).status, 404);
});

test('冻结分类区分空值类型与缺失，类别可搜索翻页，删除快照后计数更新；非法筛选被拒绝', async t => {
  const values = [null, false, 0, '0', '', undefined, ...Array.from({ length: 130 }, (_, index) => '类别' + index)];
  const records = values.map((category, index) => ({ ...row(index), ...(category === undefined ? {} : { category }) })), f = await fixture(t, records);
  await f.configure(enable(['category']));
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '冻结分类类型' })).data.version, freeze = '/api/frozen-versions/' + version.id;
  await f.request(f.route + '/batch', 'POST', { action: 'approve', versionId: version.id, questions: records.map((_, index) => ({ number: index + 1, revision: 'original' })) });
  assert.equal((await f.request(freeze + '/field-options?field=category')).data.options.length, 100);
  assert.equal((await f.request(freeze + '/field-options?field=category&page=2')).data.options.length, 36);
  assert.equal((await f.request(freeze + '/field-options?' + new URLSearchParams({ field: 'category', query: '类别129' }))).data.total, 1);
  const filters = [{ key: 'category', values: records.slice(0, 6).map(record => fieldCategory(record, 'category').value) }];
  assert.deepEqual((await f.request(freeze + '/questions?' + params(filters))).data.questions.map(item => item.number), [1, 2, 3, 4, 5, 6]);
  const meta = (await f.request(freeze)).data.dataset;
  await f.request(freeze + '/questions/1', 'DELETE', { revision: meta.revision });
  const after = (await f.request(freeze + '/questions?' + params(filters))).data;
  assert.deepEqual(after.questions.map(item => item.number), [2, 3, 4, 5, 6]);
  assert.equal((await f.request(freeze + '/field-options?field=category')).data.totalCategories, 135);
  for (const fieldFilters of [[{ key: 'answer', values: ['missing'] }], [{ key: 'category', values: [] }], [{ key: 'category', values: ['bad-token'] }]]) assert.equal((await f.request(freeze + '/questions?' + params(fieldFilters))).status, 400);
  assert.equal((await f.request(freeze + '/field-options?field=category&page=0')).status, 400);
  assert.equal((await f.request(freeze + '/field-options?field=category&query=' + 'x'.repeat(301))).status, 400);
});

test('所有key自动识别、描述和开关双审核页共享并重启恢复，原始题目不变', async t => {
  const records = [row(1), { ...row(2), custom: { 分值: 5 } }], f = await fixture(t, records);
  const original = (await f.request(f.route + '/download')).data;
  const fields = (await f.request(f.route + '/fields')).data;
  assert.deepEqual(fields.fields.map(field => field.key), [...Object.keys(records[0]), 'custom']);
  assert.ok(fields.fields.every(field => !field.filterable));
  assert.equal(fields.fields.find(field => field.key === 'custom').missingCount, 1);
  const saved = await f.configure([{ key: 'difficulty', description: '难度 <script>描述原文</script>', filterable: true }]);
  assert.equal(saved.status, 200);
  const restarted = await f.start(), expert = (await f.request('/api/expert-reviews/' + f.dataset.id + '/fields', 'GET', undefined, restarted)).data;
  assert.equal(expert.revision, saved.data.revision);
  assert.equal(expert.fields.find(field => field.key === 'difficulty').description, '难度 <script>描述原文</script>');
  assert.equal(expert.fields.find(field => field.key === 'difficulty').filterable, true);
  assert.deepEqual((await f.request(f.route + '/download')).data, original);
  assert.deepEqual((await f.request(f.route + '/questions/1')).data.record, records[0]); assert.equal(f.calls(), 0);
});

test('分类组合筛选和跨页全选一致，两个审核页结果相同，修改删除后分类计数更新', async t => {
  const records = Array.from({ length: 46 }, (_, index) => row(index + 1)), f = await fixture(t, records);
  await f.configure(enable(['difficulty', 'domain']));
  const filters = ['difficulty', 'domain'].map(key => ({ key, value: fieldCategory(records[0], key).value }));
  const expected = records.map((record, index) => ({ record, number: index + 1 })).filter(item => item.record.difficulty === '易' && item.record.domain === '铁矿石').map(item => item.number);
  const query = params(filters); query.set('pageSize', '10'); query.set('page', '2');
  const list = (await f.request(f.route + '/questions?' + query)).data;
  assert.equal(list.total, expected.length); assert.deepEqual(list.questions.map(item => item.number), expected.slice(10));
  assert.deepEqual((await f.request(f.route + '/selection?' + params(filters))).data.questions.map(item => item.number), expected);
  assert.equal((await f.request('/api/expert-reviews/' + f.dataset.id + '/questions?' + params(filters))).data.total, expected.length);
  assert.equal((await f.request(f.route + '/field-options?field=difficulty')).data.options.find(item => item.label === '易').count, 23);
  assert.equal((await f.request(f.route + '/questions/1', 'PUT', { revision: 'original', record: { ...records[0], difficulty: '中' } })).status, 200);
  assert.equal((await f.request(f.route + '/questions?' + params(filters))).data.total, expected.length - 1);
  assert.equal((await f.request(f.route + '/questions/3', 'DELETE', { revision: 'original' })).status, 200);
  assert.equal((await f.request(f.route + '/field-options?field=difficulty')).data.options.find(item => item.label === '易').count, 21);
});

test('分类区分缺失、null、false、0、文本，数组对象完整匹配，特殊key安全', async t => {
  const values = [undefined, null, false, 0, '0', '', { b: 2, a: 1 }, { a: 1, b: 2 }, ['A', 'B']];
  const records = values.map((value, index) => ({ ...row(index), ...(value === undefined ? {} : { category: value }), ...JSON.parse('{"__proto__":"安全分类"}') }));
  const f = await fixture(t, records); await f.configure(enable(['category', '__proto__']));
  const options = (await f.request(f.route + '/field-options?field=category')).data;
  assert.equal(options.total, 8); assert.equal(options.options.find(option => option.type === 'object').count, 2);
  for (const [index, record] of records.entries()) assert.equal((await f.request(f.route + '/questions?' + params([{ key: 'category', value: fieldCategory(record, 'category').value }]))).data.total, index === 6 || index === 7 ? 2 : 1);
  assert.equal((await f.request(f.route + '/questions?' + params([{ key: '__proto__', value: fieldCategory(records[0], '__proto__').value }]))).data.total, records.length);
  assert.equal({}.安全分类, undefined);
});

test('大量分类可分页搜索长值，关闭开关后旧筛选失效', async t => {
  const records = Array.from({ length: 135 }, (_, index) => ({ ...row(index), category: '分类' + String(index).padStart(3, '0') + 'x'.repeat(200) })), f = await fixture(t, records);
  await f.configure(enable(['category']));
  const first = (await f.request(f.route + '/field-options?field=category')).data, second = (await f.request(f.route + '/field-options?field=category&page=2')).data;
  assert.equal(first.options.length, 100); assert.equal(second.options.length, 35); assert.equal(first.totalCategories, 135); assert.ok(first.options.every(option => option.truncated));
  const searched = (await f.request(f.route + '/field-options?' + new URLSearchParams({ field: 'category', query: '分类134' }))).data;
  assert.equal(searched.total, 1);
  const filter = params([{ key: 'category', value: searched.options[0].value }]);
  assert.equal((await f.request(f.route + '/questions?' + filter)).data.total, 1);
  await f.configure([]); assert.equal((await f.request(f.route + '/questions?' + filter)).status, 400);
});

test('同字段多选取并集，不同字段取交集；兼容单选并与两个审核页的跨页全选一致', async t => {
  const records = Array.from({ length: 46 }, (_, index) => ({ ...row(index + 1), type: ['single_choice', 'term_completion', 'numeric_fill', 'short_answer'][index % 4] }));
  const f = await fixture(t, records); await f.configure(enable(['type', 'domain']));
  const chosenTypes = ['numeric_fill', 'short_answer'];
  const filters = [{ key: 'type', values: chosenTypes.map(type => fieldCategory({ type }, 'type').value) }, { key: 'domain', values: [fieldCategory({ domain: '铁矿石' }, 'domain').value] }];
  const expected = records.flatMap((record, index) => chosenTypes.includes(record.type) && record.domain === '铁矿石' ? [index + 1] : []);
  for (const route of [f.route, '/api/expert-reviews/' + f.dataset.id]) {
    const result = (await f.request(route + '/questions?' + params(filters))).data;
    assert.equal(result.total, expected.length); assert.deepEqual(result.questions.map(item => item.number), expected);
    assert.deepEqual((await f.request(route + '/selection?' + params(filters))).data.questions.map(item => item.number), expected);
  }
  const single = [{ key: 'type', value: filters[0].values[0] }];
  assert.equal((await f.request(f.route + '/questions?' + params(single))).data.total, records.filter(record => record.type === 'numeric_fill').length);
  for (const values of [[], ['bad-token'], [filters[0].values[0], filters[0].values[0]], 'not-an-array', [null]]) assert.equal((await f.request(f.route + '/questions?' + params([{ key: 'type', values }]))).status, 400);
});

test('多选可包含不同数据类型及缺失值，长分类跨页选取后仍准确匹配', async t => {
  const records = [undefined, null, false, 0, '0', '', ...Array.from({ length: 135 }, (_, index) => '分类' + index)].map((value, index) => ({ ...row(index), ...(value === undefined ? {} : { category: value }) }));
  const f = await fixture(t, records); await f.configure(enable(['category']));
  const chosen = [0, 1, 2, 3, 4, 140], values = chosen.map(index => fieldCategory(records[index], 'category').value);
  const result = (await f.request(f.route + '/questions?' + params([{ key: 'category', values }]))).data;
  assert.deepEqual(result.questions.map(item => item.number), chosen.map(index => index + 1));
});

test('并发、非法及跨站设置不覆盖配置，同名导入独立，损坏工作流保持原样', async t => {
  const f = await fixture(t, [row(1)]), fields = enable(['difficulty']);
  assert.equal((await f.request(f.route + '/fields', 'PUT', { revision: 'none', fields }, undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(f.route + '/fields', 'PUT', { revision: 'none', fields: enable(['unknown']) })).status, 400);
  const saved = await Promise.all([f.request(f.route + '/fields', 'PUT', { revision: 'none', fields }), f.request(f.route + '/fields', 'PUT', { revision: 'none', fields })]);
  assert.deepEqual(saved.map(result => result.status).sort(), [200, 409]);
  assert.equal((await f.request(f.route + '/questions?fieldFilters=bad')).status, 400);
  assert.equal((await f.request(f.route + '/questions?' + params([{ key: 'answer', value: 'missing' }]))).status, 400);
  const other = (await f.request('/api/technical-reviews?name=fields.json', 'POST', [row(2)])).data.dataset;
  assert.ok((await f.request('/api/technical-reviews/' + other.id + '/fields')).data.fields.every(field => !field.filterable));
  const filename = path.join(f.directory, 'technical-reviews', 'workflow.json'), bad = JSON.parse(await readFile(filename, 'utf8')); bad.fieldConfigs = 'corrupted';
  const raw = JSON.stringify(bad); await writeFile(filename, raw);
  assert.equal((await f.request(f.route + '/fields')).status, 500); assert.equal(await readFile(filename, 'utf8'), raw);
});
