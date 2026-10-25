import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';

const sample = n => ({ Question: '问题' + n, 'User Question': '用户问题' + n, 'SELECT Data': null, answer: '答案' + n, 'Scoring criteria': { 满分: 5, 得分点: [null, false, 0, { 标准: '单位准确' }] }, difficulty: n % 2 ? '易' : '难', 'Task family': 'A 点查', source: 'IO-' + n });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'expert-review-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  async function start() {
    const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { calls += 1; throw new Error('No model call expected'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  const request = async (route, method = 'GET', body, origin = url, headers = {}) => {
    const response = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const dataset = (await request('/api/technical-reviews?name=expert.json', 'POST', [sample(1), sample(2), sample(3)])).data.dataset;
  const expert = '/api/expert-reviews/' + dataset.id; const technical = '/api/technical-reviews/' + dataset.id;
  const get = (number = 1, origin = url) => request(expert + '/questions/' + number, 'GET', undefined, origin);
  const save = async (number, text, current) => {
    current ??= (await get(number)).data;
    return request(expert + '/questions/' + number + '/advice', 'PUT', { text, questionRevision: current.summary.revision, expertRevision: current.expertReview.revision });
  };
  const submit = async (number = 1, current) => {
    current ??= (await get(number)).data;
    return request(expert + '/questions/' + number + '/submit', 'POST', { questionRevision: current.summary.revision, expertRevision: current.expertReview.revision });
  };
  return { directory, request, dataset, expert, technical, get, save, submit, start, calls: () => calls };
}

test('专家和技术审核共用题目，草稿重启恢复且不显示给技术人员', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/expert-reviews')).data.datasets[0].id, f.dataset.id);
  assert.equal((await f.request(f.expert + '/questions')).data.total, 3);
  const saved = await f.save(1, '请补充含税口径\n以及单位“元/吨”。');
  assert.equal(saved.status, 200); assert.equal(saved.data.summary.expertStatus, 'draft');
  assert.equal(saved.data.dataset.expertDraftCount, 1); assert.equal(saved.data.dataset.expertAdviceCount, 0);
  assert.equal(saved.data.summary.revision, 'original');
  const restarted = await f.start();
  assert.equal((await f.get(1, restarted)).data.expertReview.draft.text, saved.data.expertReview.draft.text);
  const technical = (await f.request(f.technical + '/questions/1')).data;
  assert.equal(technical.expertAdvice, null); assert.equal(technical.expertReview, undefined);
  assert.equal((await f.request(f.technical + '/questions?query=' + encodeURIComponent('含税口径'))).data.total, 0);
  assert.equal((await f.request(f.expert + '/questions?query=' + encodeURIComponent('含税口径'))).data.total, 1);
  assert.deepEqual(technical.record, sample(1)); assert.equal(f.calls(), 0);
});

test('提交后对应技术题目显示完整建议并重新待审核，已有冻结内容不改变', async t => {
  const f = await fixture(t);
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '专家审核前版本' })).data.version;
  await f.request(f.technical + '/questions/1/approve', 'POST', { revision: 'original', versionId: version.id });
  await f.save(1, '报价单位应为元/吨，日期也需要写清楚。');
  assert.equal((await f.request(f.technical + '/questions/1')).data.summary.status, 'approved');
  const submitted = await f.submit(); assert.equal(submitted.status, 200);
  assert.equal(submitted.data.expertReview.draft, null); assert.equal(submitted.data.summary.expertStatus, 'submitted');
  assert.notEqual(submitted.data.summary.revision, 'original'); assert.equal(submitted.data.summary.status, 'pending');
  const technical = (await f.request(f.technical + '/questions/1')).data;
  assert.equal(technical.expertAdvice.text, '报价单位应为元/吨，日期也需要写清楚。'); assert.equal(technical.expertAdvice.isCurrent, true);
  assert.equal(technical.expertAdvice.history.length, 1); assert.deepEqual(technical.record, sample(1));
  assert.equal((await f.request(f.technical + '/questions?advice=with&status=pending')).data.total, 1);
  assert.equal((await f.request(f.technical + '/questions?advice=without')).data.total, 2);
  assert.deepEqual((await f.request('/api/frozen-versions/' + version.id + '/download')).data, [sample(1)]);
  assert.deepEqual((await f.request(f.technical + '/download')).data, [sample(1), sample(2), sample(3)]);
  assert.equal((await f.request(f.technical + '/questions/1', 'PUT', { revision: 'original', record: sample(8) })).status, 409);
});

test('新草稿不覆盖已提交建议，多次提交保留历史和明确的当前版本关联', async t => {
  const f = await fixture(t); await f.save(1, '第一次意见'); await f.submit();
  await f.save(1, '第二次意见，补充评分落点');
  assert.equal((await f.request(f.technical + '/questions/1')).data.expertAdvice.text, '第一次意见');
  const result = await f.submit(); assert.equal(result.data.expertReview.history.length, 2);
  const technical = (await f.request(f.technical + '/questions/1')).data;
  assert.equal(technical.expertAdvice.text, '第二次意见，补充评分落点');
  assert.deepEqual(technical.expertAdvice.history.map(item => item.text), ['第二次意见，补充评分落点', '第一次意见']);
  const changed = await f.request(f.technical + '/questions/1', 'PUT', { revision: technical.summary.revision, record: { ...sample(1), answer: '按建议修订后的答案' } });
  assert.equal(changed.data.expertAdvice.isCurrent, false); assert.equal(changed.data.expertAdvice.text, technical.expertAdvice.text);
  assert.equal((await f.request(f.technical + '/questions?advice=outdated')).data.total, 1);
  await f.save(1, '修订后的答案仍需补充日期'); assert.equal((await f.submit()).status, 200);
});

test('题目或建议被其他页面修改时旧草稿保存与提交均被拦截', async t => {
  const f = await fixture(t); const original = (await f.get()).data;
  const results = await Promise.all([f.save(1, '建议 A', original), f.save(1, '建议 B', original)]);
  assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
  const draft = (await f.get()).data;
  await f.request(f.technical + '/questions/1', 'PUT', { revision: draft.summary.revision, record: { ...sample(1), answer: '技术已更新' } });
  assert.equal((await f.submit(1, draft)).status, 409);
  assert.equal((await f.save(1, '旧页面的意见', draft)).status, 409);
  assert.equal((await f.get()).data.summary.draftOutdated, true);
  const current = (await f.get()).data;
  assert.equal((await f.submit(1, current)).data.error.code, 'EXPERT_DRAFT_OUTDATED');
  const refreshed = await f.save(1, '已重新核对的意见', current); assert.equal(refreshed.status, 200);
  assert.equal((await f.submit(1, refreshed.data)).status, 200);
  assert.equal((await f.submit()).data.error.code, 'EXPERT_DRAFT_REQUIRED');
});

test('专家批量提交与全选筛选一致，任一草稿缺失或过期时整批不执行', async t => {
  const f = await fixture(t); await f.save(1, '意见 1'); await f.save(3, '意见 3');
  const choose = async filters => (await f.request(f.expert + '/selection?' + new URLSearchParams(filters))).data.questions.map(({ number, revision, expertRevision }) => ({ number, revision, expertRevision }));
  const drafts = await choose({ expertStatus: 'draft' }); assert.deepEqual(drafts.map(item => item.number), [1, 3]);
  const failed = await f.request(f.expert + '/submit', 'POST', { questions: await choose({}) }); assert.equal(failed.status, 400);
  assert.equal((await f.request(f.technical + '/questions?advice=with')).data.total, 0);
  const saved = (await f.get(3)).data; await f.save(3, '更新后的意见 3', saved);
  assert.equal((await f.request(f.expert + '/submit', 'POST', { questions: drafts })).status, 409);
  assert.equal((await f.request(f.technical + '/questions?advice=with')).data.total, 0);
  const passed = await f.request(f.expert + '/submit', 'POST', { questions: await choose({ expertStatus: 'draft' }) });
  assert.equal(passed.status, 200); assert.equal(passed.data.affectedCount, 2);
  assert.equal((await f.request(f.expert + '/questions?expertStatus=draft')).data.total, 0);
  assert.equal((await f.request(f.expert + '/questions?expertStatus=submitted')).data.total, 2);
  assert.equal((await f.request(f.technical + '/questions?advice=with')).data.total, 2);
  assert.deepEqual((await f.request(f.technical + '/questions/2')).data.record, sample(2));
});

test('同题号和来源的不同导入评测集分别保存专家建议，不发生串题', async t => {
  const f = await fixture(t); const second = (await f.request('/api/technical-reviews?name=another.json', 'POST', [sample(1)])).data.dataset;
  await f.save(1, '只属于第一个评测集'); await f.submit();
  const other = (await f.request('/api/expert-reviews/' + second.id + '/questions/1')).data;
  assert.equal(other.expertReview.submitted, null); assert.equal(other.expertReview.draft, null);
  assert.equal((await f.request('/api/technical-reviews/' + second.id + '/questions/1')).data.expertAdvice, null);
});

test('输入长度、编码控制字符、请求方法、跨站和删除题目均验证，失败不覆盖', async t => {
  const f = await fixture(t);
  for (const text of ['', '  ', 'x'.repeat(20001), 'a\u0000b', null, { text: 'bad' }]) assert.equal((await f.save(1, text)).status, 400);
  assert.equal((await f.save(1, 'x'.repeat(20000))).status, 200);
  assert.equal((await f.request(f.expert + '/questions/1/advice', 'PUT', { text: '拒绝跨站' }, undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(f.expert + '/questions/1/advice', 'PUT', { text: '非法类型' }, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(f.expert + '/questions?expertStatus=unknown')).status, 400);
  assert.equal((await f.request(f.expert + '/selection/1')).status, 404);
  assert.equal((await f.request(f.expert + '/submit', 'POST', { questions: [] })).status, 400);
  assert.equal((await f.request(f.expert + '/questions/1', 'DELETE', {})).status, 404);
  await f.request(f.technical + '/questions/1', 'DELETE', { revision: 'original' });
  assert.equal((await f.get()).status, 404); assert.equal((await f.save(1, '已删除题目的意见', { summary: { revision: 'original' }, expertReview: { revision: 'none' } })).status, 404);
  assert.equal((await f.request('/data/technical-reviews/workflow.json')).status, 404);
});

test('旧版审核文件兼容读取，损坏的专家建议记录不会被覆盖', async t => {
  const f = await fixture(t); const filename = path.join(f.directory, 'technical-reviews', 'workflow.json');
  const legacy = JSON.stringify({ version: 1, changes: [], versions: [] }); await writeFile(filename, legacy);
  assert.equal((await f.get()).status, 200); assert.equal(await readFile(filename, 'utf8'), legacy);
  await f.save(1, '新增专家建议草稿'); const valid = await readFile(filename, 'utf8');
  const corrupt = JSON.parse(valid); corrupt.expertReviews[0].submissions = 'bad'; await writeFile(filename, JSON.stringify(corrupt));
  const before = await readFile(filename, 'utf8');
  assert.equal((await f.request(f.expert + '/questions/1/advice', 'PUT', { text: '不能覆盖', questionRevision: 'original', expertRevision: 'none' })).status, 500);
  assert.equal(await readFile(filename, 'utf8'), before);
  await writeFile(filename, valid); assert.equal((await f.get()).data.expertReview.draft.text, '新增专家建议草稿');
});
