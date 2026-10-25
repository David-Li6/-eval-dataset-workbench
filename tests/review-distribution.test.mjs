import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { reviewDistribution } from '../review-distribution.mjs';
import { fieldCategory } from '../review-fields.mjs';

test('200 题单字段条形图计数、占比和首次出现顺序准确，二维矩阵与边际合计相符', () => {
  const counts = [60, 23, 23, 9, 17, 5, 9, 20, 7, 27];
  const records = counts.flatMap((count, index) => Array.from({ length: count }, (_, n) => ({ family: String.fromCharCode(65 + index), difficulty: ['易', '中', '难'][n % 3] })));
  const one = reviewDistribution(records, ['family']);
  assert.equal(one.total, 200); assert.deepEqual(one.axes[0].categories.map(category => category.count), counts);
  assert.equal(one.axes[0].categories[0].percentage, 30); assert.equal(one.axes[0].categories.at(-1).percentage, 13.5);
  const matrix = reviewDistribution(records, ['family', 'difficulty']);
  assert.equal(matrix.cells.reduce((sum, cell) => sum + cell.count, 0), 200);
  for (const row of matrix.axes[0].categories) assert.equal(matrix.cells.filter(cell => cell.row === row.value).reduce((sum, cell) => sum + cell.count, 0), row.count);
  for (const column of matrix.axes[1].categories) assert.equal(matrix.cells.filter(cell => cell.column === column.value).reduce((sum, cell) => sum + cell.count, 0), column.count);
});

test('分布区分缺失、null、零值、文本和布尔值，对象属性顺序不拆分，高基数矩阵使用稀疏结果', () => {
  const values = [undefined, null, false, 0, '0', '', { a: 1, b: 2 }, { b: 2, a: 1 }, ['A', 'B']];
  const records = values.map(value => value === undefined ? {} : { key: value });
  const result = reviewDistribution(records, ['key']);
  assert.equal(result.total, 9); assert.equal(result.axes[0].categories.length, 8);
  assert.equal(result.axes[0].categories.find(category => category.type === 'object').count, 2);
  assert.ok(result.axes[0].categories.some(category => category.type === 'missing'));
  const large = reviewDistribution(Array.from({ length: 10000 }, (_, index) => ({ a: '行' + index, b: '列' + index })), ['a', 'b']);
  assert.equal(large.axes[0].categories.length, 10000); assert.equal(large.axes[1].categories.length, 10000);
  assert.equal(large.cells.length, 10000);
  assert.deepEqual(reviewDistribution([], ['key', 'other']), { fields: ['key', 'other'], total: 0, axes: [{ key: 'key', categories: [] }, { key: 'other', categories: [] }], cells: [] });
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'distribution-test-')); let calls = 0;
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { calls++; throw new Error('No model call expected'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const url = 'http://127.0.0.1:' + server.address().port;
  async function request(route, method = 'GET', body) {
    const response = await fetch(url + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const records = Array.from({ length: 46 }, (_, index) => ({ question: '问题' + (index + 1), answer: '答案' + (index + 1), category: ['A', 'B', 'C'][index % 3], domain: index % 2 ? '钢铁' : '矿石' }));
  const dataset = (await request('/api/technical-reviews?name=distribution.json', 'POST', records)).data.dataset, review = '/api/technical-reviews/' + dataset.id, expert = '/api/expert-reviews/' + dataset.id;
  await request(review + '/fields', 'PUT', { revision: 'none', fields: ['category', 'domain'].map(key => ({ key, description: '', filterable: true })) });
  const version = (await request('/api/frozen-versions', 'POST', { name: '分布版本' })).data.version, frozen = '/api/frozen-versions/' + version.id;
  await request(review + '/batch', 'POST', { action: 'approve', versionId: version.id, questions: records.slice(0, 30).map((_, index) => ({ number: index + 1, revision: 'original' })) });
  const query = (fields, filters = {}) => new URLSearchParams({ fields: JSON.stringify(fields), ...filters });
  return { directory, request, records, review, expert, frozen, query, calls: () => calls };
}

test('三个页面只统计已启用 key，统计覆盖所有页并与搜索、状态、字段筛选一致，GET 不改动数据', async t => {
  const f = await fixture(t), workflowPath = path.join(f.directory, 'technical-reviews', 'workflow.json'), original = await readFile(workflowPath, 'utf8');
  for (const [route, records] of [[f.review, f.records], [f.expert, f.records], [f.frozen, f.records.slice(0, 30)]]) {
    const result = await f.request(route + '/distribution?' + f.query(['category'], { page: '2', pageSize: '1' }));
    assert.equal(result.status, 200); assert.equal(result.data.total, records.length);
    assert.deepEqual(result.data, reviewDistribution(records, ['category']));
    const filters = [{ key: 'category', values: ['A', 'B'].map(category => fieldCategory({ category }, 'category').value) }];
    const expected = records.filter(record => ['A', 'B'].includes(record.category) && record.domain === '矿石');
    const combined = await f.request(route + '/distribution?' + f.query(['category', 'domain'], { fieldFilters: JSON.stringify([...filters, { key: 'domain', values: [fieldCategory({ domain: '矿石' }, 'domain').value] }]) }));
    assert.deepEqual(combined.data, reviewDistribution(expected, ['category', 'domain']));
    assert.equal((await f.request(route + '/distribution?' + f.query(['category'], { query: '问题46' }))).data.total, route === f.frozen ? 0 : 1);
  }
  assert.equal((await f.request(f.review + '/distribution?' + f.query(['category'], { status: 'pending' }))).data.total, 16);
  assert.equal((await f.request(f.review + '/distribution?' + f.query(['category'], { status: 'approved' }))).data.total, 30);
  assert.equal(await readFile(workflowPath, 'utf8'), original); assert.equal(f.calls(), 0);
});

test('审核修改和删除更新分布，冻结仅使用保留快照，专家草稿及已提交状态筛选正确', async t => {
  const f = await fixture(t);
  await f.request(f.review + '/questions/1', 'PUT', { revision: 'original', record: { ...f.records[0], category: '新增分类' } });
  const technical = (await f.request(f.review + '/distribution?' + f.query(['category']))).data;
  assert.equal(technical.axes[0].categories.find(category => category.label === '新增分类').count, 1);
  const frozenBefore = (await f.request(f.frozen + '/distribution?' + f.query(['category']))).data;
  assert.ok(!frozenBefore.axes[0].categories.some(category => category.label === '新增分类'));
  const meta = (await f.request(f.frozen)).data.dataset;
  await f.request(f.frozen + '/questions/1', 'DELETE', { revision: meta.revision });
  assert.equal((await f.request(f.frozen + '/distribution?' + f.query(['category']))).data.total, 29);
  await f.request(f.review + '/questions/46', 'DELETE', { revision: 'original' });
  assert.equal((await f.request(f.review + '/distribution?' + f.query(['category']))).data.total, 45);
  const detail = (await f.request(f.expert + '/questions/2')).data;
  const draft = (await f.request(f.expert + '/questions/2/advice', 'PUT', { text: '分布测试建议', questionRevision: detail.summary.revision, expertRevision: detail.expertReview.revision })).data;
  assert.equal((await f.request(f.expert + '/distribution?' + f.query(['category'], { expertStatus: 'draft' }))).data.total, 1);
  await f.request(f.expert + '/questions/2/submit', 'POST', { questionRevision: draft.summary.revision, expertRevision: draft.expertReview.revision });
  assert.equal((await f.request(f.expert + '/distribution?' + f.query(['category'], { expertStatus: 'submitted' }))).data.total, 1);
  assert.equal((await f.request(f.review + '/distribution?' + f.query(['category'], { advice: 'with' }))).data.total, 1);
});

test('拒绝非法维度、关闭的分类字段及无效筛选，空结果返回可验证的零样本结构', async t => {
  const f = await fixture(t);
  for (const route of [f.review, f.expert, f.frozen]) {
    for (const fields of [[], ['category', 'category'], ['category', 'domain', 'answer'], ['answer'], [null], 'category']) {
      const result = await f.request(route + '/distribution?' + f.query(fields)); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_DISTRIBUTION_FIELDS');
    }
    assert.equal((await f.request(route + '/distribution?fields=bad')).status, 400);
    assert.equal((await f.request(route + '/distribution?' + f.query(['category'], { fieldFilters: 'bad' }))).status, 400);
    const empty = (await f.request(route + '/distribution?' + f.query(['category', 'domain'], { query: '完全不匹配的内容' }))).data;
    assert.equal(empty.total, 0); assert.deepEqual(empty.cells, []); assert.ok(empty.axes.every(axis => !axis.categories.length));
  }
  const current = (await f.request(f.review + '/fields')).data;
  await f.request(f.review + '/fields', 'PUT', { revision: current.revision, fields: [{ key: 'domain', description: '', filterable: true }] });
  assert.equal((await f.request(f.frozen + '/distribution?' + f.query(['category']))).status, 400);
});
