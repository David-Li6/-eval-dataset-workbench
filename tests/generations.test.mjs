import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { createGenerationPlan, validateGeneratedBatch } from '../generation-data.mjs';
import { generationFields } from '../public/generation-utils.js';

const record = (n, ref = 'SRC-0001') => ({ Question: '完整评测问题' + n, 'User Question': '用户问题' + n, 'SELECT Data': null, answer: '参考答案' + n, 'Scoring criteria': { 满分: 5, 得分点: [{ 分值: 5, 标准: '口径准确' }] }, difficulty: '中', 'Task family': 'A 点查', source: 'IO-001（' + ref + '）' });
const done = ['completed', 'failed', 'cancelled', 'interrupted'];
async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'generation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = [], serial = 0, mode = 'valid', secret = 'fixture-private-key';
  const fetchImpl = async (url, input) => {
    const body = JSON.parse(input.body); calls.push({ url, ...input, body });
    await options.beforeModelResponse?.(input);
    if (mode === 'wait') return new Promise((resolve, reject) => { input.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); });
    if (mode === 'auth') return new Response(JSON.stringify({ error: { message: 'Bad API Key: ' + secret } }), { status: 401 });
    const count = Number(body.messages[1].content.match(/本批必须生成 (\d+) 道题/)[1]);
    const ref = body.messages[1].content.match(/\[(SRC-\d+)\]/)[1];
    let content = JSON.stringify(Array.from({ length: count }, () => record(++serial, ref)));
    if (mode === 'invalid' || mode === 'once-invalid' && calls.length === 1 || mode === 'partial-error' && calls.length > 1) content = 'not JSON';
    if (mode === 'citation') content = JSON.stringify([record(++serial, 'SRC-9999')]);
    if (mode === 'empty') content = '';
    return new Response(JSON.stringify({ choices: [{ finish_reason: mode === 'length' ? 'length' : 'stop', message: { content } }], usage: { total_tokens: 100 } }));
  };
  const extract = options.extract || (async (filename, name) => ({ ok: true, units: [{ text: '原题 ID：IO-001\n专家意见：回答需包含单位。文件内容 ' + name, location: '第 2 行', originalId: 'IO-001' }], characters: 50, sha256: 'hash-' + name, notes: [] }));
  async function start() {
    const server = createAppServer({ configPath: path.join(directory, 'config.json'), generationExtract: extract, fetchImpl, vault: { encrypt: async key => 'encrypted:' + key, decrypt: async key => key.slice(10) } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  const request = async (route, method = 'GET', body, origin = url, headers = {}) => {
    const response = await fetch(origin + route, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  };
  const provider = (await request('/api/providers', 'POST', { name: '测试模型配置', baseUrl: 'https://model.example/v1', models: ['test-model'], timeoutSeconds: 60, apiKey: secret })).data.provider;
  const upload = async (name = 'source.txt') => { const response = await fetch(url + '/api/files?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: '原始资料与专家结论' }); return (await response.json()).file; };
  const file = await upload();
  const create = (settings = {}, origin = url) => request('/api/generations', 'POST', { name: '生成评测集', fileIds: [file.id], providerId: provider.id, model: 'test-model', count: 7, batchSize: 3, ...settings }, origin);
  const wait = async (id, expected = done, origin = url) => { const deadline = Date.now() + 8000; while (Date.now() < deadline) { const result = await request('/api/generations/' + id, 'GET', undefined, origin); if (expected.includes(result.data.job.status)) return result.data.job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('generation did not settle'); };
  return { directory, url, provider, file, upload, request, create, wait, start, calls: () => calls, setMode: value => { mode = value; } };
}

test('分批计划覆盖材料并满足总题数；八字段、有效引用和重复问题均校验', () => {
  const units = [1, 2].map(n => ({ text: 'x'.repeat(12000), ref: 'SRC-' + String(n).padStart(4, '0') }));
  const plan = createGenerationPlan(units, 9, 3);
  assert.equal(plan.reduce((sum, batch) => sum + batch.count, 0), 9); assert.ok(plan.every(batch => batch.count <= 3));
  assert.equal(new Set(plan.flatMap(batch => batch.units.map(unit => unit.ref))).size, 2);
  const single = createGenerationPlan(units, 1, 3);
  assert.equal(single.length, 1); assert.equal(single[0].count, 1);
  const valid = validateGeneratedBatch('```json\n' + JSON.stringify([record(1)]) + '\n```', 1, new Set(['SRC-0001']));
  assert.deepEqual(Object.keys(valid[0]), generationFields);
  assert.throws(() => validateGeneratedBatch(JSON.stringify([record(1), record(1)]), 2, new Set(['SRC-0001'])), /重复/);
  assert.throws(() => validateGeneratedBatch(JSON.stringify([record(1, 'SRC-9999')]), 1, new Set(['SRC-0001'])), /有效 SRC/);
  assert.throws(() => validateGeneratedBatch(JSON.stringify([{ ...record(1), 'User Question': '' }]), 1, new Set(['SRC-0001'])), /非空文字/);
});

test('生成批数仅按题数和每批题数计算，资料较多时均匀抽选，最后一批使用剩余题数', () => {
  const units = Array.from({ length: 12 }, (_, index) => ({ text: String(index).padStart(2, '0') + 'x'.repeat(9998), ref: 'SRC-' + String(index + 1).padStart(4, '0') }));
  const before = JSON.stringify(units);
  for (const count of [1, 2, 3, 9, 11, 12, 13, 25, 1000]) {
    for (const batchSize of [1, 3, 5, 10]) {
      const plan = createGenerationPlan(units, count, batchSize);
      const batches = Math.ceil(count / batchSize);
      assert.equal(plan.length, batches);
      assert.deepEqual(plan.map(batch => batch.count), Array.from({ length: batches }, (_, index) => Math.min(batchSize, count - index * batchSize)));
      assert.equal(plan.reduce((total, batch) => total + batch.count, 0), count);
      assert.ok(plan.every(batch => batch.count >= 1 && batch.count <= batchSize && batch.units.length && batch.units.reduce((sum, unit) => sum + unit.text.length, 0) <= 18000));
      const refs = new Set(plan.flatMap(batch => batch.units.map(unit => unit.ref)));
      assert.equal(refs.size, Math.min(batches, units.length));
      if (batches > 1) { assert.ok(refs.has('SRC-0001')); assert.ok(refs.has('SRC-0012')); }
    }
  }
  assert.equal(JSON.stringify(units), before);
  assert.throws(() => createGenerationPlan([], 9, 5), /没有可生成/);
});

test('12 批源资料生成 9 题且每批 5 题时只请求两批 5+4，生成 1 题只请求一批', async t => {
  const units = Array.from({ length: 12 }, (_, index) => ({ text: '原题' + index + 'x'.repeat(10000), location: '第 ' + (index + 1) + ' 行', originalId: 'IO-' + index }));
  const f = await fixture(t, { extract: async () => ({ ok: true, units, sha256: '12-chunks' }) });
  for (const count of [9, 1]) {
    const beforeCalls = f.calls().length;
    const created = await f.create({ count, batchSize: 5 });
    const expectedCounts = count === 9 ? [5, 4] : [1];
    assert.equal(created.data.job.batchCount, expectedCounts.length);
    const job = await f.wait(created.data.job.id);
    assert.equal(job.status, 'completed'); assert.equal(job.completedCount, count); assert.equal(job.batchCount, expectedCounts.length);
    assert.equal(job.sourceSampled, true); assert.equal(job.sourceRefs.length, 12); assert.equal(job.selectedSourceUnitCount, expectedCounts.length);
    const listed = (await f.request('/api/generations')).data.jobs.find(item => item.id === job.id);
    assert.equal(listed.sourceUnitCount, 12); assert.equal(listed.selectedSourceUnitCount, expectedCounts.length);
    const output = (await f.request('/api/generations/' + job.id + '/download')).data;
    assert.equal(output.length, count);
    assert.equal(new Set(output.map(item => item.source)).size, expectedCounts.length);
    const calls = f.calls().slice(beforeCalls);
    assert.equal(calls.length, expectedCounts.length);
    assert.deepEqual(calls.map(call => Number(call.body.messages[1].content.match(/本批必须生成 (\d+) 道题/)[1])), expectedCounts);
    assert.ok(calls.every((call, index) => call.body.messages[1].content.includes('当前批次生成 ' + expectedCounts[index] + ' 道')));
    assert.equal(new Set(calls.flatMap(call => [...call.body.messages[1].content.matchAll(/\[(SRC-\d+)\]/g)].map(match => match[1]))).size, expectedCounts.length);
    assert.deepEqual(Object.keys(output[0]), generationFields);
  }
});

test('旧版9题9批任务的已有题目保留，继续时补齐每批5题，进度改为两批', async t => {
  const units = Array.from({ length: 12 }, (_, index) => ({ text: '原题' + index + 'x'.repeat(10000), location: '第 ' + (index + 1) + ' 行' }));
  for (const [savedCount, expectedCounts] of [[1, [4, 4]], [5, [4]], [6, [3]], [9, []]]) {
    const f = await fixture(t, { extract: async () => ({ ok: true, units, sha256: 'unchanged-source' }) });
    f.setMode('invalid');
    const job = await f.wait((await f.create({ count: 9, batchSize: 5 })).data.job.id);
    const retained = Array.from({ length: savedCount }, (_, index) => ({ ...record(1000 + index), answer: '需要原样保留的答案' + index }));
    await writeFile(path.join(f.directory, 'generations', job.id + '.partial.json'), JSON.stringify(retained));
    const filename = path.join(f.directory, 'generations', 'index.json');
    const store = JSON.parse(await readFile(filename, 'utf8'));
    Object.assign(store.jobs.find(item => item.id === job.id), { completedCount: savedCount, completedBatches: savedCount, currentBatch: savedCount + 1, batchCount: 9 });
    await writeFile(filename, JSON.stringify(store));
    const restarted = await f.start(); f.setMode('valid'); const beforeCalls = f.calls().length;
    const displayed = (await f.request('/api/generations', 'GET', undefined, restarted)).data.jobs.find(item => item.id === job.id);
    assert.equal(displayed.batchCount, 2); assert.equal(displayed.currentBatch, Math.min(Math.floor(savedCount / 5) + 1, 2));
    assert.equal((await f.request('/api/generations/' + job.id, 'GET', undefined, restarted)).data.job.batchCount, 2);
    const resumed = await f.request('/api/generations/' + job.id + '/resume', 'POST', {}, restarted);
    assert.equal(resumed.status, 202); assert.equal(resumed.data.job.batchCount, 2);
    const completed = await f.wait(job.id, done, restarted);
    assert.equal(completed.status, 'completed'); assert.equal(completed.completedCount, 9); assert.equal(completed.completedBatches, 2); assert.equal(completed.batchCount, 2);
    assert.deepEqual(f.calls().slice(beforeCalls).map(call => Number(call.body.messages[1].content.match(/本批必须生成 (\d+) 道题/)[1])), expectedCounts);
    const output = (await f.request('/api/generations/' + job.id + '/download', 'GET', undefined, restarted)).data;
    assert.deepEqual(output.slice(0, savedCount), retained);
    assert.equal(output.length, 9); assert.equal(new Set(output.map(item => item['User Question'])).size, 9);
  }
});

test('旧版因资料批数大于 9 题失败的零产出任务，更新后可继续生成并保留任务 ID', async t => {
  const units = Array.from({ length: 12 }, (_, index) => ({ text: '原题' + index + 'x'.repeat(10000), location: '第 ' + (index + 1) + ' 行' }));
  const f = await fixture(t, { extract: async () => ({ ok: true, units, sha256: 'unchanged-source' }) });
  f.setMode('invalid');
  const job = await f.wait((await f.create({ count: 9, batchSize: 5 })).data.job.id);
  assert.equal(job.completedCount, 0);
  const filename = path.join(f.directory, 'generations', 'index.json');
  const store = JSON.parse(await readFile(filename, 'utf8'));
  const legacy = store.jobs.find(item => item.id === job.id);
  legacy.error = '资料需要分成 12 批读取，请将题数增加至至少 12，或减少所选文件。';
  for (const key of ['sourceHashes', 'sourceRefs', 'sourceSampled', 'selectedSourceUnitCount', 'currentBatch', 'attempt']) delete legacy[key];
  legacy.batchCount = 0;
  await writeFile(filename, JSON.stringify(store));
  const restarted = await f.start(); f.setMode('valid');
  assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {}, restarted)).status, 202);
  const completed = await f.wait(job.id, done, restarted);
  assert.equal(completed.id, job.id); assert.equal(completed.status, 'completed'); assert.equal(completed.completedCount, 9);
  assert.equal((await f.request('/api/generations/' + job.id + '/download', 'GET', undefined, restarted)).data.length, 9);
});

test('多个源文件通过已保存模型真实请求接口，分批产出完整 JSON，密钥不出现在存储与 API', async t => {
  const f = await fixture(t); const second = await f.upload('second.csv');
  const created = await f.create({ fileIds: [f.file.id, second.id] }); assert.equal(created.status, 202);
  const job = await f.wait(created.data.job.id); assert.equal(job.status, 'completed'); assert.equal(job.completedCount, 7); assert.equal(f.calls().length, 3);
  assert.ok(f.calls().every(call => call.url === 'https://model.example/v1/chat/completions' && call.headers.Authorization === 'Bearer fixture-private-key' && call.redirect === 'error'));
  assert.ok(f.calls()[0].body.messages[1].content.includes('source.txt')); assert.ok(f.calls()[0].body.messages[1].content.includes('second.csv'));
  const output = await f.request('/api/generations/' + job.id + '/download'); assert.equal(output.data.length, 7); assert.deepEqual(Object.keys(output.data[0]), generationFields);
  const all = (await f.request('/api/generations')).data; assert.equal(all.jobs[0].sourceUnitCount, 2); assert.equal(all.jobs[0].prompt, undefined);
  assert.ok(!JSON.stringify(all).includes('fixture-private-key')); assert.ok(!(await readFile(path.join(f.directory, 'generations', 'index.json'), 'utf8')).includes('fixture-private-key'));
  assert.equal((await f.request('/api/generations/' + job.id + '/questions?query=' + encodeURIComponent('参考答案7'))).data.total, 1);
  assert.equal((await f.request('/api/generations/' + job.id + '/questions/7')).data.record.answer, '参考答案7');
});

test('格式失败仅重试当前批次，失败保留已生成部分，继续后不重做已完成批次', async t => {
  const f = await fixture(t); f.setMode('partial-error');
  const created = await f.create({ count: 4, batchSize: 2 }); let job = await f.wait(created.data.job.id);
  assert.equal(job.status, 'failed'); assert.equal(job.completedCount, 2); assert.equal(f.calls().length, 3);
  const partial = (await f.request('/api/generations/' + job.id + '/partial')).data; assert.equal(partial.length, 2);
  assert.equal((await f.request('/api/generations/' + job.id + '/download')).status, 409);
  f.setMode('valid'); assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {})).status, 202);
  job = await f.wait(job.id); assert.equal(job.status, 'completed'); assert.equal(job.completedCount, 4); assert.equal(f.calls().length, 4);
  assert.deepEqual((await f.request('/api/generations/' + job.id + '/download')).data.slice(0, 2), partial);
});

test('可停止模型请求并继续，重新启动后任务标记中断且完整进度可恢复', async t => {
  const f = await fixture(t); f.setMode('wait');
  let job = (await f.create({ count: 1, batchSize: 1 })).data.job; await f.wait(job.id, ['running']);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal((await f.request('/api/generations/' + job.id + '/cancel', 'POST', {})).status, 200);
  await f.wait(job.id, ['cancelled']); await new Promise(resolve => setTimeout(resolve, 30));
  f.setMode('valid'); assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {})).status, 202);
  job = await f.wait(job.id); assert.equal(job.status, 'completed');
  const count = f.calls().length, filename = path.join(f.directory, 'generations', 'index.json'), store = JSON.parse(await readFile(filename, 'utf8'));
  store.jobs[0].status = 'running'; await writeFile(filename, JSON.stringify(store));
  const restarted = await f.start();
  assert.equal((await f.request('/api/generations', 'GET', undefined, restarted)).data.jobs[0].status, 'interrupted');
  assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {}, restarted)).status, 202);
  assert.equal((await f.wait(job.id, ['completed', 'failed'], restarted)).status, 'completed'); assert.equal(f.calls().length, count);
});

test('删除源文档后禁止新建任务，已有任务重启后可继续，生成 JSON 和审核副本均保留', async t => {
  let extractions = 0;
  const f = await fixture(t, { extract: async filename => {
    assert.equal(await readFile(filename, 'utf8'), '原始资料与专家结论');
    extractions += 1;
    return { ok: true, units: [{ text: '原始专家结论', location: '第 1 行' }], sha256: 'original-hash' };
  } });
  f.setMode('partial-error');
  let job = await f.wait((await f.create({ count: 4, batchSize: 2 })).data.job.id);
  assert.equal(job.status, 'failed'); assert.equal(job.completedCount, 2);
  const partial = (await f.request('/api/generations/' + job.id + '/partial')).data;
  const calls = f.calls().length;
  assert.equal((await f.request('/api/files/' + f.file.id, 'DELETE', {})).status, 200);
  assert.equal((await f.create({ count: 1 })).status, 404);
  assert.equal(f.calls().length, calls);
  const restarted = await f.start();
  assert.deepEqual((await f.request('/api/files', 'GET', undefined, restarted)).data.files, []);
  f.setMode('valid');
  assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {}, restarted)).status, 202);
  job = await f.wait(job.id, done, restarted);
  assert.equal(job.status, 'completed'); assert.equal(job.completedCount, 4); assert.equal(extractions, 2);
  const output = (await f.request('/api/generations/' + job.id + '/download', 'GET', undefined, restarted)).data;
  assert.deepEqual(output.slice(0, 2), partial);
  const review = await f.request('/api/generations/' + job.id + '/review', 'POST', {}, restarted);
  assert.equal(review.status, 200);
  const question = await f.request('/api/technical-reviews/' + review.data.dataset.id + '/questions/1', 'GET', undefined, restarted);
  assert.deepEqual(question.data.record, output[0]);
  assert.equal((await f.request('/api/files/' + f.file.id + '/download', 'GET', undefined, restarted)).status, 404);
  assert.equal((await f.request('/api/generations/' + job.id, 'GET', undefined, restarted)).data.job.sources[0].name, f.file.name);
});

test('送入审核幂等，两个审核页面共用生成结果，原始来源与 JSON 字段保留', async t => {
  const f = await fixture(t); const job = await f.wait((await f.create({ count: 2 })).data.job.id);
  const first = await f.request('/api/generations/' + job.id + '/review', 'POST', {}); const second = await f.request('/api/generations/' + job.id + '/review', 'POST', {});
  assert.equal(first.status, 200); assert.equal(first.data.dataset.id, second.data.dataset.id);
  assert.equal((await f.request('/api/technical-reviews')).data.datasets.length, 1);
  const expert = (await f.request('/api/expert-reviews/' + job.id + '/questions/1')).data; assert.deepEqual(Object.keys(expert.record), generationFields);
  assert.equal(expert.expertReview.submitted, null); assert.ok(expert.record.source.includes('SRC-0001'));
});

test('删除审核副本后保留生成 JSON，可重新送审生成全新副本并保持重复送审幂等', async t => {
  const f = await fixture(t); const job = await f.wait((await f.create({ count: 1 })).data.job.id);
  const original = (await f.request('/api/generations/' + job.id + '/download')).data;
  const first = (await f.request('/api/generations/' + job.id + '/review', 'POST', {})).data.dataset;
  const changed = await f.request('/api/technical-reviews/' + first.id + '/questions/1', 'PUT', { revision: 'original', record: { ...original[0], answer: '审核区改过的答案' } });
  assert.equal(changed.status, 200);
  const deleted = await f.request('/api/expert-reviews/' + first.id, 'DELETE', { revision: changed.data.dataset.revision });
  assert.equal(deleted.status, 200);
  assert.equal((await f.request('/api/generations')).data.jobs[0].reviewDatasetId, null);
  assert.equal((await f.request('/api/generations/' + job.id)).data.job.reviewDatasetId, null);
  assert.deepEqual((await f.request('/api/generations/' + job.id + '/download')).data, original);
  const next = (await f.request('/api/generations/' + job.id + '/review', 'POST', {})).data.dataset;
  assert.notEqual(next.id, first.id);
  assert.deepEqual((await f.request('/api/technical-reviews/' + next.id + '/questions/1')).data.record, original[0]);
  const repeated = await Promise.all([f.request('/api/generations/' + job.id + '/review', 'POST', {}), f.request('/api/generations/' + job.id + '/review', 'POST', {})]);
  assert.ok(repeated.every(result => result.data.dataset.id === next.id));
  assert.equal((await f.request('/api/technical-reviews')).data.datasets.length, 1);
  assert.equal((await f.request('/api/generations')).data.jobs[0].reviewDatasetId, next.id);
  assert.equal(f.calls().length, 1);
});

test('继续前核对源文件哈希与模型配置修订，变化时保留原有部分且不追加调用', async t => {
  let hash = 'original-hash';
  const f = await fixture(t, { extract: async () => ({ ok: true, units: [{ text: '原始专家结论', location: '第 2 行', originalId: 'IO-001' }], characters: 6, sha256: hash }) });
  f.setMode('partial-error');
  let job = await f.wait((await f.create({ count: 4, batchSize: 2 })).data.job.id);
  assert.equal(job.completedCount, 2);
  const before = (await f.request('/api/generations/' + job.id + '/partial')).data;
  const calls = f.calls().length;
  hash = 'changed-hash'; f.setMode('valid');
  assert.equal((await f.request('/api/generations/' + job.id + '/resume', 'POST', {})).status, 202);
  job = await f.wait(job.id);
  assert.equal(job.status, 'failed'); assert.match(job.error, /源文件.*已变化/);
  assert.equal(f.calls().length, calls);
  assert.deepEqual((await f.request('/api/generations/' + job.id + '/partial')).data, before);
  const edited = await f.request('/api/providers/' + f.provider.id, 'PUT', { name: f.provider.name, baseUrl: 'https://changed.example/v1', models: f.provider.models, timeoutSeconds: 60, apiKey: '', revision: f.provider.revision });
  assert.equal(edited.status, 200);
  const resumed = await f.request('/api/generations/' + job.id + '/resume', 'POST', {});
  assert.equal(resumed.status, 409); assert.equal(resumed.data.error.code, 'PROVIDER_CHANGED');
  assert.equal(f.calls().length, calls);
});

test('自动模板变量使用当前批次材料和题数，其余变量必须填写', async t => {
  const f = await fixture(t);
  const settings = { count: 2, batchSize: 1, prompt: '领域 {{领域}}，本批 {{题目数量}}，总数 {{总题目数量}}。{{参考资料}}' };
  assert.equal((await f.create(settings)).data.error.code, 'MISSING_GENERATION_VARIABLE'); assert.equal(f.calls().length, 0);
  const job = await f.wait((await f.create({ ...settings, values: { 领域: '铁矿石', 参考资料: '不能替换系统资料' } })).data.job.id);
  assert.equal(job.status, 'completed'); assert.ok(f.calls()[0].body.messages[1].content.includes('领域 铁矿石，本批 1，总数 2'));
  assert.ok(!f.calls()[0].body.messages[1].content.includes('不能替换系统资料'));
});

test('模型 HTTP 错误脱敏，空响应、截断和无效来源不标为完成', async t => {
  const f = await fixture(t);
  for (const mode of ['auth', 'empty', 'length', 'citation']) {
    f.setMode(mode); const job = await f.wait((await f.create({ count: 1 })).data.job.id);
    assert.equal(job.status, 'failed'); assert.equal(job.completedCount, 0); assert.ok(!job.error.includes('fixture-private-key'));
  }
});

test('输入、跨站、未知格式与存储保护在调用模型前检查', async t => {
  const f = await fixture(t); const unsupported = await f.upload('legacy.doc');
  for (const settings of [{ count: 0 }, { count: 1001 }, { batchSize: 0 }, { fileIds: [] }, { fileIds: [f.file.id, f.file.id] }, { prompt: '' }, { model: 'unknown' }, { name: '../bad' }, { fileIds: [unsupported.id] }]) assert.equal((await f.create(settings)).status, 400);
  assert.equal((await f.request('/api/generations', 'POST', {}, undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request('/api/generations', 'POST', {}, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/data/generations/index.json')).status, 404); assert.equal(f.calls().length, 0);
  assert.equal((await fetch(f.url + '/source-datasets')).status, 200);
});

test('损坏任务列表不覆盖，源读取失败不会发送模型请求', async t => {
  const f = await fixture(t, { extract: async () => { throw new Error('源文件为空'); } });
  const job = await f.wait((await f.create()).data.job.id); assert.equal(job.status, 'failed'); assert.equal(f.calls().length, 0);
  const filename = path.join(f.directory, 'generations', 'index.json'); await writeFile(filename, 'original corrupted store');
  assert.equal((await f.create()).status, 500); assert.equal(await readFile(filename, 'utf8'), 'original corrupted store');
});

test('删除生成任务持久隐藏全部入口，保留源文件、同名其他任务、审核副本和冻结快照', async t => {
  const f = await fixture(t);
  const job = await f.wait((await f.create({ count: 1 })).data.job.id);
  const original = (await f.request('/api/generations/' + job.id + '/download')).data;
  const dataset = (await f.request('/api/generations/' + job.id + '/review', 'POST', {})).data.dataset;
  const version = (await f.request('/api/frozen-versions', 'POST', { name: '任务删除验证版本' })).data.version;
  assert.equal((await f.request('/api/technical-reviews/' + dataset.id + '/questions/1/approve', 'POST', { revision: 'original', versionId: version.id })).status, 200);
  const retained = await f.wait((await f.create({ count: 1 })).data.job.id);
  const resultBefore = await readFile(path.join(f.directory, 'generations', job.id + '.json'), 'utf8');
  const calls = f.calls().length;
  assert.equal((await f.request('/api/generations/' + job.id, 'DELETE', {})).status, 200);
  const restarted = await f.start();
  assert.deepEqual((await f.request('/api/generations', 'GET', undefined, restarted)).data.jobs.map(item => item.id), [retained.id]);
  for (const suffix of ['', '/download', '/partial', '/questions', '/questions/1', '?includeDeleted=true']) assert.equal((await f.request('/api/generations/' + job.id + suffix, 'GET', undefined, restarted)).status, 404);
  for (const command of ['resume', 'cancel', 'review']) assert.equal((await f.request('/api/generations/' + job.id + '/' + command, 'POST', {}, restarted)).status, 404);
  assert.equal((await f.request('/api/files/' + f.file.id, 'GET', undefined, restarted)).status, 200);
  assert.deepEqual((await f.request('/api/technical-reviews/' + dataset.id + '/questions/1', 'GET', undefined, restarted)).data.record, original[0]);
  assert.deepEqual((await f.request('/api/expert-reviews/' + dataset.id + '/questions/1', 'GET', undefined, restarted)).data.record, original[0]);
  assert.deepEqual((await f.request('/api/frozen-versions/' + version.id + '/download', 'GET', undefined, restarted)).data, original);
  assert.equal(await readFile(path.join(f.directory, 'generations', job.id + '.json'), 'utf8'), resultBefore);
  assert.equal(f.calls().length, calls);
});

test('删除运行和排队任务会中止请求，晚到回复不会复活任务或写入结果，其他排队任务仍正常完成', async t => {
  let releaseResponse, modelStarted;
  const started = new Promise(resolve => { modelStarted = resolve; });
  let modelCalls = 0;
  const f = await fixture(t, { beforeModelResponse: async () => {
    if (++modelCalls === 1) { modelStarted(); await new Promise(resolve => { releaseResponse = resolve; }); }
  } });
  t.after(() => releaseResponse?.());
  const running = (await f.create({ count: 4, batchSize: 2 })).data.job;
  await started;
  const queued = (await f.create({ count: 1 })).data.job;
  const retained = (await f.create({ count: 1 })).data.job;
  assert.equal((await f.request('/api/generations/' + queued.id, 'DELETE', {})).status, 200);
  assert.equal((await f.request('/api/generations/' + running.id, 'DELETE', {})).status, 200);
  assert.equal(f.calls()[0].signal.aborted, true);
  releaseResponse();
  assert.equal((await f.wait(retained.id)).status, 'completed');
  assert.equal(f.calls().length, 2);
  const store = JSON.parse(await readFile(path.join(f.directory, 'generations', 'index.json'), 'utf8'));
  for (const id of [running.id, queued.id]) {
    const archived = store.jobs.find(item => item.id === id);
    assert.ok(archived.deletedAt); assert.equal(archived.completedCount, 0);
    await assert.rejects(readFile(path.join(f.directory, 'generations', id + '.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(path.join(f.directory, 'generations', id + '.partial.json')), { code: 'ENOENT' });
  }
  const restarted = await f.start();
  const after = (await f.request('/api/generations', 'GET', undefined, restarted)).data.jobs;
  assert.deepEqual(after.map(item => item.id), [retained.id]);
  assert.equal(f.calls().length, 2);
});

test('失败及已停止任务可删除，部分结果归档保留；最后一个任务删除后列表为空', async t => {
  const f = await fixture(t); f.setMode('partial-error');
  const failed = await f.wait((await f.create({ count: 4, batchSize: 2 })).data.job.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.completedCount, 2);
  const filename = path.join(f.directory, 'generations', failed.id + '.partial.json');
  const partialBefore = await readFile(filename, 'utf8');
  assert.equal((await f.request('/api/generations/' + failed.id, 'DELETE', {})).status, 200);
  assert.equal(await readFile(filename, 'utf8'), partialBefore);
  f.setMode('wait');
  const cancelled = (await f.create({ count: 1 })).data.job;
  await f.wait(cancelled.id, ['running']);
  assert.equal((await f.request('/api/generations/' + cancelled.id + '/cancel', 'POST', {})).status, 200);
  assert.equal((await f.request('/api/generations/' + cancelled.id, 'DELETE', {})).status, 200);
  assert.deepEqual((await f.request('/api/generations')).data.jobs, []);
});

test('删除拒绝跨站、错误格式和损坏存储，并发删除只成功一次', async t => {
  const f = await fixture(t); const job = await f.wait((await f.create({ count: 1 })).data.job.id);
  const route = '/api/generations/' + job.id;
  assert.equal((await f.request(route, 'DELETE', {}, undefined, { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.request(route, 'DELETE', {}, undefined, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request(route, 'DELETE', [])).status, 400);
  assert.equal((await f.request(route)).status, 200);
  const deleted = await Promise.all([f.request(route, 'DELETE', {}), f.request(route, 'DELETE', {})]);
  assert.deepEqual(deleted.map(result => result.status).sort(), [200, 404]);
  const filename = path.join(f.directory, 'generations', 'index.json'); const saved = await readFile(filename, 'utf8');
  assert.equal((await f.request(route, 'DELETE', {})).status, 404); assert.equal(await readFile(filename, 'utf8'), saved);
  await writeFile(filename, 'original corrupted store');
  assert.equal((await f.request(route, 'DELETE', {})).status, 500); assert.equal(await readFile(filename, 'utf8'), 'original corrupted store');
});
