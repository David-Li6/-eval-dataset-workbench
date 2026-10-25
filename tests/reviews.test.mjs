import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { DatasetError, parseEvaluationDataset, previewReviewRecord } from '../review-data.mjs';
import { identifyReviewFields, orderedReviewFields } from '../public/review-utils.js';

const sample = index => ({
  Question: '给定报价数据，请回答测试题' + index,
  'User Question': '测试问题' + index + '怎么回答？',
  'SELECT Data': index % 2 ? null : { 日期: '2026-08-19', 报价: 685 + index },
  answer: '参考答案' + index,
  'Scoring criteria': { 满分: 5, 得分点: [{ 分值: 2, 标准: '数值准确' }, { 分值: 3, 标准: '口径正确' }], 封顶规则: [{ 触发条件: '编造数据', 最高分: 0 }] },
  difficulty: ['易', '中', '难'][index % 3],
  'Task family': index % 2 ? 'A 点查' : 'C 对比',
  source: 'IO-' + String(index).padStart(3, '0')
});
const parse = value => parseEvaluationDataset(Buffer.from(JSON.stringify(value)));

async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'technical-review-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  const create = () => createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { modelCalls += 1; throw new Error('No model call expected'); } });
  const url = await listen(t, create());
  const get = async (route, origin = url) => { const response = await fetch(origin + route); return { status: response.status, data: await response.json() }; };
  const upload = async (value, name = '评测集.json', headers = {}) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const response = await fetch(url + '/api/technical-reviews?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: buffer });
    return { status: response.status, data: await response.json() };
  };
  return { directory, url, create, get, upload, modelCalls: () => modelCalls };
}

test('识别八个标准字段，题目顺序与嵌套评分数据不改变', () => {
  const input = [sample(1), sample(2)];
  const output = parse(input);
  assert.deepEqual(output.items, input);
  assert.equal(output.summaries[0].question, input[0]['User Question']);
  assert.equal(output.summaries[0].number, 1);
  assert.equal(output.stats.fieldCount, 8);
  assert.equal(output.stats.issueCount, 0);
  assert.equal(output.items[0]['SELECT Data'], null);
});

test('支持包装对象、嵌套题目数组、单题以及大小写和下划线字段别名', () => {
  assert.equal(parse({ data: [sample(1)] }).format, 'data 数组');
  assert.equal(parse({ data: { questions: [sample(1)] } }).format, 'data.questions 数组');
  assert.equal(parse(sample(1)).format, '单题对象');
  const input = { question: '简单提问', user_question: '真实提问', ANSWER: false, task_family: '知识', 难度: '中', scoring_criteria: { 分数: 5 } };
  const out = parse([input]);
  assert.equal(out.summaries[0].question, '真实提问');
  assert.equal(out.summaries[0].family, '知识');
  assert.equal(out.summaries[0].difficulty, '中');
  assert.equal(out.stats.issueCount, 0);
  assert.equal(identifyReviewFields(input)['Scoring criteria'], 'scoring_criteria');
});

test('保留额外字段、空值、零值、false 以及特殊属性，缺失题目也完整保留', () => {
  const input = JSON.parse('{"Question":"原题","answer":0,"User Question":null,"extra":{"nested":[false,null,0]},"__proto__":{"text":"仅为数据"}}');
  const output = parse([input, { unknown: '没有标准问题或答案字段' }]);
  assert.deepEqual(output.items[0], input);
  assert.equal(output.summaries[0].question, '原题');
  assert.equal(output.summaries[0].issues.length, 0);
  assert.equal(output.summaries[1].issues.length, 2);
  assert.equal(output.stats.questionCount, 2);
  assert.equal(output.stats.issueCount, 1);
  assert.ok(orderedReviewFields(input).some(item => item.key === '__proto__'));
});

test('识别 UTF-8 BOM 和 UTF-16，拒绝语法错误、模糊数组、空数组和非对象记录', () => {
  const text = JSON.stringify([sample(1)]);
  assert.equal(parseEvaluationDataset(Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(text)])).stats.questionCount, 1);
  assert.equal(parseEvaluationDataset(Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')])).stats.questionCount, 1);
  assert.throws(() => parseEvaluationDataset(Buffer.from('[{bad}]')), error => error instanceof DatasetError && error.code === 'INVALID_DATASET_JSON');
  assert.throws(() => parse({ data: [sample(1)], questions: [sample(2)] }), { code: 'AMBIGUOUS_DATASET' });
  assert.throws(() => parse([]), { code: 'EMPTY_DATASET' });
  assert.throws(() => parse([sample(1), 'broken']), error => error.code === 'INVALID_QUESTION_RECORD' && error.message.includes('第 2 条'));
  assert.throws(() => parse({ unsupported: [] }), DatasetError);
  assert.throws(() => parse(null), DatasetError);
});

test('限制过深嵌套与过多题目', () => {
  let deep = {};
  for (let i = 0; i < 80; i++) deep = { child: deep };
  assert.throws(() => parse([{ ...sample(1), deep }]), { code: 'DATASET_TOO_DEEP' });
  assert.throws(() => parse(Array.from({ length: 10001 }, () => ({ Question: 'q', answer: 'a' }))), { code: 'TOO_MANY_QUESTIONS' });
});

test('实际 key 的并集按首次出现顺序保留，超过 100 个字段也不省略', () => {
  const first = { id: 'CPT001', type: '单选', question: '问题', options: ['A', 'B'], response_unit: null };
  const extra = Object.fromEntries(Array.from({ length: 110 }, (_, index) => ['自定义' + index, index]));
  const parsed = parse([first, { question: '第二题', ...extra }]);
  assert.deepEqual(parsed.stats.fieldNames, [...Object.keys(first), ...Object.keys(extra)]);
  assert.equal(parsed.stats.fieldNames.length, parsed.stats.fieldCount);
});

test('字段预览区分 null、false、0、空字符串及结构化数据，长值标记缩略且不改变原题', () => {
  const record = JSON.parse('{"id":0,"type":"单选","question":"<script>仅为题面</script>","options":{"A":"甲","B":"乙"},"response_unit":null,"flag":false,"empty":"","__proto__":{"data":true}}');
  record.long = '完整意见'.repeat(300);
  const original = JSON.stringify(record); const fields = previewReviewRecord(record); const value = key => fields.find(field => field.key === key);
  assert.equal(value('id').text, '0'); assert.equal(value('response_unit').text, 'null'); assert.equal(value('flag').text, 'false'); assert.equal(value('empty').text, '""');
  assert.equal(value('question').isPrimary, true); assert.equal(value('question').text, record.question);
  assert.equal(value('options').kind, 'object'); assert.deepEqual(JSON.parse(value('options').text), record.options);
  assert.deepEqual(JSON.parse(value('__proto__').text), record.__proto__);
  assert.equal(value('long').truncated, true); assert.equal(value('long').text.length, 600);
  assert.equal(JSON.stringify(record), original);
});

test('两个审核列表返回实际字段和值，跨页与筛选使用同一组列，修改和删除后仍正确对应原题', async t => {
  const f = await fixture(t);
  const records = [{ id: 'CPT001', type: '单选', question: '如何选择？', options: { A: '关键词：选项正文', B: '乙' }, response_unit: null, flag: false, count: 0 }, { 题干: '第二题', 专属字段: '仅第二条才有' }, { question: '第三题', answer: '完整答案' }];
  const dataset = (await f.upload({ questions: records })).data.dataset;
  const expected = ['id', 'type', 'question', 'options', 'response_unit', 'flag', 'count', '题干', '专属字段', 'answer'];
  for (const api of ['/api/technical-reviews', '/api/expert-reviews']) {
    const route = api + '/' + dataset.id + '/questions';
    const page = (await f.get(route + '?pageSize=1&page=2')).data;
    assert.deepEqual(page.dataset.fieldNames, expected); assert.equal(page.questions[0].number, 2);
    assert.deepEqual(page.questions[0].fieldPreviews.map(field => field.key), Object.keys(records[1]));
    const filtered = (await f.get(route + '?query=' + encodeURIComponent('关键词：选项正文'))).data;
    assert.equal(filtered.total, 1); assert.deepEqual(filtered.dataset.fieldNames, expected);
    assert.equal(filtered.questions[0].fieldPreviews.find(field => field.key === 'flag').text, 'false');
  }
  const third = '/api/technical-reviews/' + dataset.id + '/questions/3';
  const edited = { ...records[2], 新增字段: ['甲', false, 0, null] };
  const saved = await fetch(f.url + third, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 'original', record: edited }) });
  assert.equal(saved.status, 200);
  const deleted = await fetch(f.url + '/api/technical-reviews/' + dataset.id + '/questions/1', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: 'original' }) });
  assert.equal(deleted.status, 200);
  const current = (await f.get('/api/expert-reviews/' + dataset.id + '/questions')).data;
  assert.deepEqual(current.questions.map(question => question.number), [2, 3]);
  assert.deepEqual(current.dataset.fieldNames, [...expected, '新增字段']);
  assert.deepEqual(JSON.parse(current.questions[1].fieldPreviews.find(field => field.key === '新增字段').text), edited.新增字段);
  assert.deepEqual((await f.get('/api/technical-reviews/' + dataset.id + '/download')).data.questions, records);
  for (const number of [2, 3]) {
    const route = '/api/technical-reviews/' + dataset.id + '/questions/' + number;
    const revision = (await f.get(route)).data.summary.revision;
    assert.equal((await fetch(f.url + route, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }) })).status, 200);
  }
  const empty = (await f.get('/api/technical-reviews/' + dataset.id + '/questions')).data;
  assert.equal(empty.total, 0); assert.deepEqual(empty.dataset.fieldNames, expected);
  assert.equal(f.modelCalls(), 0);
});

test('导入后持久保存，重启恢复；下载保留原始字节且不调用模型', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.get('/api/technical-reviews')).data.datasets, []);
  const buffer = Buffer.concat([Buffer.from([239, 187, 191]), Buffer.from(JSON.stringify({ questions: [sample(1), sample(2)] }, null, 2))]);
  const saved = await f.upload(buffer);
  assert.equal(saved.status, 201);
  const dataset = saved.data.dataset;
  assert.equal(dataset.questionCount, 2);
  assert.equal(dataset.fieldCount, 8);
  const restarted = await listen(t, f.create());
  const list = await f.get('/api/technical-reviews', restarted);
  assert.equal(list.data.datasets[0].id, dataset.id);
  assert.equal((await f.get('/api/technical-reviews/' + dataset.id, restarted)).data.dataset.questionCount, 2);
  const download = await fetch(restarted + '/api/technical-reviews/' + dataset.id + '/download');
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent('评测集.json')));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), buffer);
  assert.equal(f.modelCalls(), 0);
});

test('分页展示稳定原始序号，查询与难度任务族筛选一致', async t => {
  const f = await fixture(t);
  const items = Array.from({ length: 45 }, (_, i) => sample(i + 1));
  const dataset = (await f.upload(items)).data.dataset;
  const route = '/api/technical-reviews/' + dataset.id + '/questions';
  const first = (await f.get(route)).data;
  assert.equal(first.questions.length, 20);
  assert.equal(first.totalPages, 3);
  assert.equal(first.questions[0].number, 1);
  assert.ok(!Object.hasOwn(first.questions[0], 'searchText'));
  const second = (await f.get(route + '?page=2&pageSize=20')).data;
  assert.equal(second.questions[0].number, 21);
  assert.equal(second.questions.at(-1).number, 40);
  const query = (await f.get(route + '?query=' + encodeURIComponent('参考答案42'))).data;
  assert.equal(query.total, 1);
  assert.equal(query.questions[0].number, 42);
  const filtered = (await f.get(route + '?difficulty=' + encodeURIComponent('易') + '&family=' + encodeURIComponent('C 对比'))).data;
  assert.ok(filtered.questions.every(item => item.number % 6 === 0));
  const missing = (await f.get(route + '?query=notfound')).data;
  assert.equal(missing.total, 0);
  assert.equal(missing.page, 1);
  assert.equal((await f.get(route + '?page=99')).data.page, 3);
});

test('详情包含所有原始字段和嵌套评分标准，单题不存在给出 404', async t => {
  const f = await fixture(t);
  const record = { ...sample(1), 自定义字段: { 备注: ['核对单位', '核对日期'] } };
  const dataset = (await f.upload([record])).data.dataset;
  const result = await f.get('/api/technical-reviews/' + dataset.id + '/questions/1');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.record, record);
  assert.equal(result.data.record['Scoring criteria'].封顶规则[0].最高分, 0);
  assert.equal((await f.get('/api/technical-reviews/' + dataset.id + '/questions/2')).status, 404);
  assert.equal((await f.get('/api/technical-reviews/' + dataset.id + '/questions/0')).status, 400);
});

test('未识别字段的记录保留并可通过识别提示筛选', async t => {
  const f = await fixture(t);
  const dataset = (await f.upload([sample(1), { text: '自定义题目格式' }, { Question: '没有答案' }])).data.dataset;
  assert.equal(dataset.issueCount, 2);
  const result = await f.get('/api/technical-reviews/' + dataset.id + '/questions?issues=missing');
  assert.deepEqual(result.data.questions.map(item => item.number), [2, 3]);
  assert.deepEqual((await f.get('/api/technical-reviews/' + dataset.id + '/questions/2')).data.record, { text: '自定义题目格式' });
});

test('并发和同名评测集分别保存，错误导入不会影响已有数据', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.upload([sample(1)]), f.upload([sample(2)])]);
  assert.ok(results.every(result => result.status === 201));
  assert.notEqual(results[0].data.dataset.id, results[1].data.dataset.id);
  const before = (await f.get('/api/technical-reviews')).data.datasets;
  assert.equal((await f.upload(Buffer.from('not json'))).status, 400);
  assert.deepEqual((await f.get('/api/technical-reviews')).data.datasets, before);
});

test('验证后缀、编码、跨站、参数和大文件，静态路径不能读取数据', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload([sample(1)], 'file.txt')).status, 400);
  assert.equal((await f.upload([sample(1)], '../file.json')).status, 400);
  assert.equal((await f.upload([sample(1)], 'file.json', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.upload([sample(1)], 'file.json', { Origin: 'https://other.example' })).status, 403);
  assert.equal((await f.upload(Buffer.from([255, 255, 255]))).status, 400);
  const id = (await f.upload([sample(1)])).data.dataset.id;
  for (const parameters of ['page=0', 'pageSize=101', 'page=abc', 'issues=approved']) assert.equal((await f.get('/api/technical-reviews/' + id + '/questions?' + parameters)).status, 400);
  assert.equal((await fetch(f.url + '/data/technical-reviews/' + id + '.json')).status, 404);
  assert.equal((await fetch(f.url + '/technical-review')).status, 200);
  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(f.url + '/api/technical-reviews?name=large.json', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': 21 * 1024 * 1024 } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(oversized, 413);
});

test('损坏索引不覆盖，导入失败不留下新文件', async t => {
  const f = await fixture(t);
  await f.upload([sample(1)]);
  const directory = path.join(f.directory, 'technical-reviews');
  await writeFile(path.join(directory, 'index.json'), 'corrupt original');
  const before = await readdir(directory);
  assert.equal((await f.upload([sample(2)])).status, 500);
  assert.equal(await readFile(path.join(directory, 'index.json'), 'utf8'), 'corrupt original');
  assert.deepEqual((await readdir(directory)).sort(), before.sort());
});
