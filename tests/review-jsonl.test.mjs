import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { parseEvaluationDataset } from '../review-data.mjs';

const row = n => ({ question: '问题' + n + '\n第二行', answer: '答案' + n, type: n === 1 ? '单选' : '简答', options: [{ label: 'A', text: '甲' }], data: [null, false, 0], scoring: { 满分: 5 } });
const jsonl = records => records.map(record => JSON.stringify(record)).join('\r\n') + '\r\n';
const parse = text => parseEvaluationDataset(Buffer.from(text), { format: 'jsonl' });

test('JSONL 按非空行识别题目，保留顺序、原始 key、嵌套数据和字符串换行', () => {
  const records = [row(1), { ...row(2), extra: false }];
  const parsed = parse('\ufeff\r\n' + JSON.stringify(records[0]) + '\r\n \t\r\n' + JSON.stringify(records[1]) + '\n\n');
  assert.deepEqual(parsed.items, records);
  assert.equal(parsed.format, 'JSONL（每行一题）');
  assert.deepEqual(parsed.stats.fieldNames, [...Object.keys(records[0]), 'extra']);
  assert.equal(parsed.stats.issueCount, 0);
  assert.deepEqual(parsed.summaries.map(item => item.number), [1, 2]);
  assert.deepEqual(parse('{"自定义问题":"任意字段","answer":0}').items, [{ 自定义问题: '任意字段', answer: 0 }]);
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from(jsonl(records), 'utf16le')]);
  assert.deepEqual(parseEvaluationDataset(utf16, { format: 'jsonl' }).items, records);
});

test('JSONL 错误显示物理行号，拒绝非对象、外层数组、空文件、超限和过深嵌套', () => {
  for (const [invalid, code] of [['{"question":', 'INVALID_DATASET_JSON'], ['{"question":"题"},', 'INVALID_DATASET_JSON'], ['[]', 'INVALID_QUESTION_RECORD'], ['null', 'INVALID_QUESTION_RECORD'], ['false', 'INVALID_QUESTION_RECORD'], ['"题目"', 'INVALID_QUESTION_RECORD']]) {
    assert.throws(() => parse(JSON.stringify(row(1)) + '\n \n' + invalid), error => error.code === code && error.message.includes('第 3 行'));
  }
  assert.throws(() => parse('\ufeff\n\t\r\n'), { code: 'EMPTY_DATASET' });
  assert.throws(() => parse(jsonl(Array.from({ length: 10001 }, () => ({ question: '题目' })))), { code: 'TOO_MANY_QUESTIONS' });
  let deep = {};
  for (let n = 0; n < 75; n++) deep = { child: deep };
  assert.throws(() => parse('\n' + JSON.stringify({ question: '深层题目', deep })), error => error.code === 'DATASET_TOO_DEEP' && error.message.includes('第 2 行'));
  assert.throws(() => parseEvaluationDataset(Buffer.from(jsonl([row(1), row(2)]))), { code: 'INVALID_DATASET_JSON' });
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-jsonl-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let modelCalls = 0;
  async function start() {
    const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { modelCalls++; throw new Error('No model call expected'); } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const url = await start();
  async function request(route, method = 'GET', body, origin = url) {
    const response = await fetch(origin + route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function upload(text, name = '评测集.JSONL', type = 'application/octet-stream') {
    const response = await fetch(url + '/api/technical-reviews?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': type }, body: text });
    return { status: response.status, data: await response.json() };
  }
  return { directory, url, start, request, upload, calls: () => modelCalls };
}

test('JSONL 导入在两个审核页识别字段、分类筛选及专家建议，修改通过和重启恢复，原下载逐字节保留', async t => {
  const f = await fixture(t), records = [row(1), row(2)];
  const raw = Buffer.from('\ufeff\r\n' + jsonl(records) + '\r\n'), name = '中文评测集.JSONL';
  const uploaded = await f.upload(raw, name, 'application/x-ndjson');
  assert.equal(uploaded.status, 201);
  const dataset = uploaded.data.dataset;
  assert.equal(dataset.questionCount, 2); assert.equal(dataset.format, 'JSONL（每行一题）');
  const technical = '/api/technical-reviews/' + dataset.id, expert = '/api/expert-reviews/' + dataset.id;
  const fields = (await f.request(technical + '/fields')).data;
  assert.deepEqual(fields.fields.map(field => field.key), Object.keys(records[0]));
  const savedFields = await f.request(expert + '/fields', 'PUT', { revision: fields.revision, fields: [{ key: 'type', description: '题型', filterable: true }] });
  assert.equal(savedFields.status, 200);
  const options = (await f.request(expert + '/field-options?field=type')).data.options;
  const filter = new URLSearchParams({ fieldFilters: JSON.stringify([{ key: 'type', values: [options.find(item => item.label === '简答').value] }]) });
  for (const route of [technical, expert]) {
    assert.deepEqual((await f.request(route + '/questions/1')).data.record, records[0]);
    assert.deepEqual((await f.request(route + '/questions?' + filter)).data.questions.map(item => item.number), [2]);
    assert.equal((await f.request(route + '/fields')).data.fields.find(field => field.key === 'type').description, '题型');
  }
  const current = (await f.request(expert + '/questions/1')).data;
  const draft = await f.request(expert + '/questions/1/advice', 'PUT', { text: '补充答案说明', questionRevision: current.summary.revision, expertRevision: current.expertReview.revision });
  const submitted = await f.request(expert + '/questions/1/submit', 'POST', { questionRevision: draft.data.summary.revision, expertRevision: draft.data.expertReview.revision });
  assert.equal(submitted.status, 200);
  const original = (await f.request(technical + '/questions/1')).data;
  assert.equal(original.expertAdvice.text, '补充答案说明');
  const record = { ...records[0], answer: '已修订的答案', 新字段: { 保留: true } };
  const edited = await f.request(technical + '/questions/1', 'PUT', { revision: original.summary.revision, record });
  assert.equal(edited.status, 200);
  const version = (await f.request('/api/frozen-versions', 'POST', { name: 'JSONL 评测版本' })).data.version;
  assert.equal((await f.request(technical + '/questions/1/approve', 'POST', { revision: edited.data.summary.revision, versionId: version.id })).status, 200);
  assert.equal((await f.request(technical + '/questions/2', 'DELETE', { revision: 'original' })).status, 200);
  const restarted = await f.start();
  for (const route of [technical, expert]) {
    const list = (await f.request(route + '/questions', 'GET', undefined, restarted)).data;
    assert.deepEqual(list.questions.map(item => item.number), [1]); assert.equal(list.dataset.deletedCount, 1);
    assert.deepEqual((await f.request(route + '/questions/1', 'GET', undefined, restarted)).data.record, record);
    assert.equal((await f.request(route + '/fields', 'GET', undefined, restarted)).data.fields.find(field => field.key === 'type').filterable, true);
  }
  assert.deepEqual((await f.request('/api/frozen-versions/' + version.id + '/download', 'GET', undefined, restarted)).data, [record]);
  const download = await fetch(restarted + technical + '/download');
  assert.equal(download.status, 200); assert.ok(download.headers.get('content-disposition').includes('filename="dataset.jsonl"'));
  assert.ok(download.headers.get('content-disposition').includes(encodeURIComponent(name)));
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), raw);
  assert.equal(f.calls(), 0);
});

test('JSONL 错误整批拒绝且不覆盖旧文件，JSON 原有结构继续可用，前后端均接受两种扩展名', async t => {
  const f = await fixture(t);
  assert.equal((await f.upload(JSON.stringify({ questions: [row(1)] }), '原有.json', 'application/json')).status, 201);
  const indexPath = path.join(f.directory, 'technical-reviews', 'index.json');
  const before = await readFile(indexPath, 'utf8'), beforeFiles = await readdir(path.dirname(indexPath));
  for (const [raw, name, code] of [[jsonl([row(1)]) + '\n{bad}', '损坏.jsonl', 'INVALID_DATASET_JSON'], [JSON.stringify([row(1)]), '数组.jsonl', 'INVALID_QUESTION_RECORD'], [jsonl([row(1), row(2)]), '错误扩展名.json', 'INVALID_DATASET_JSON'], [jsonl([row(1)]), '错误扩展名.txt', 'INVALID_DATASET_FILENAME']]) {
    const result = await f.upload(raw, name);
    assert.equal(result.status, 400); assert.equal(result.data.error.code, code);
  }
  assert.equal(await readFile(indexPath, 'utf8'), before);
  assert.deepEqual(await readdir(path.dirname(indexPath)), beforeFiles);
  assert.equal((await f.upload(jsonl([row(2)]), '有效.jsonl', 'application/jsonl')).status, 201);
  for (const route of ['/expert-review', '/technical-review']) {
    const html = await (await fetch(f.url + route)).text();
    assert.match(html, /accept="\.json,\.jsonl,/); assert.match(html, /JSONL 每行一道题/);
  }
});
