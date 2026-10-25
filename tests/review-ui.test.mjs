// Exercise the actual page modules against a local API with a small DOM test double.
// This validates event wiring and workflow; it is not a browser layout test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.hidden = false; this.disabled = false; this._value = ''; this._text = ''; this.style = {}; this.classList = { add() {}, remove() {} }; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = this.tagName === 'SELECT' && !this.options.some(option => option.value === String(value)) ? '' : String(value); }
  get value() { return this._value; }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; if (this.tagName === 'SELECT') this._value = children[0]?.value || ''; }
  add(option, index = this.children.length) { this.children.splice(index, 0, option); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async dispatch(type) { for (const listener of this.listeners.get(type) || []) await listener({ preventDefault() {}, target: this }); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  select() {}
  reset() {}
}
class OptionElement extends Element {
  constructor(text, value) { super('option'); this.textContent = text; this.value = value; }
}
function documentFor(html) {
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) { const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[2]); elements.set(match[3], element); }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) elements.get(match[1]).replaceChildren(...[...match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(option => new OptionElement(option[2], option[1])));
  const document = new Element('document'); document.getElementById = id => elements.get(id) || null; document.createElement = tag => new Element(tag);
  return { document, get: id => { assert.ok(elements.has(id), 'HTML element exists: ' + id); return elements.get(id); } };
}
function find(root, predicate) { if (predicate(root)) return root; for (const child of root.children) { const result = find(child, predicate); if (result) return result; } }
async function waitFor(check) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('Page state did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('送审入口在两个审核页定位对应评测集并只弹出一次字段配置，已有配置保留，缺失目标不误开其他文件', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-config-link-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { throw new Error('No model call expected'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, nativeFetch = globalThis.fetch;
  const previous = Object.fromEntries(['document', 'Option', 'location', 'history', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options); globalThis.Option = OptionElement;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  const api = async (route, method = 'GET', body) => (await fetch(route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })).json();
  const target = (await api('/api/technical-reviews?name=generated.json', 'POST', [{ question: '送审题目', answer: '答案', category: '点查' }])).dataset;
  await api('/api/technical-reviews/' + target.id + '/fields', 'PUT', { revision: 'none', fields: [{ key: 'category', description: '已有字段描述', filterable: true }] });
  const distractor = (await api('/api/technical-reviews?name=generated.json', 'POST', [{ question: '另一份同名评测集', answer: '答案', extra: true }])).dataset;
  for (const page of ['expert-review', 'technical-review']) {
    let dom = documentFor(await readFile(new URL('../public/' + page + '.html', import.meta.url), 'utf8')), get = dom.get;
    globalThis.document = dom.document; globalThis.location = new URL(url + '/' + page + '?dataset=' + target.id + '&configureFields=1&keep=value');
    let replacements = 0;
    globalThis.history = { state: { kept: true }, replaceState(state, _title, nextUrl) { assert.deepEqual(state, { kept: true }); replacements++; globalThis.location = new URL(nextUrl, url); } };
    await import('../public/technical-review.js?config-link-' + page);
    await waitFor(() => get('review-fields-dialog').open && get('review-fields-rows').textContent.includes('category'));
    assert.equal(get('dataset-select').value, target.id);
    const description = find(get('review-fields-rows'), element => element.getAttribute('aria-label') === '字段描述：category');
    const enabled = find(get('review-fields-rows'), element => element.getAttribute('aria-label') === '启用分类筛选：category');
    assert.equal(description.value, '已有字段描述'); assert.equal(enabled.checked, true);
    assert.equal(replacements, 1); assert.equal(location.searchParams.get('configureFields'), null);
    assert.equal(location.searchParams.get('dataset'), target.id); assert.equal(location.searchParams.get('keep'), 'value');
    await get('cancel-review-fields').dispatch('click');
    await get('refresh-datasets').dispatch('click'); await waitFor(() => !get('refresh-datasets').disabled);
    assert.equal(get('review-fields-dialog').open, false); assert.equal(replacements, 1);
    // A removed or invalid destination must never open the newest import's configuration instead.
    dom = documentFor(await readFile(new URL('../public/' + page + '.html', import.meta.url), 'utf8')); get = dom.get;
    globalThis.document = dom.document; globalThis.location = new URL(url + '/' + page + '?dataset=00000000-0000-0000-0000-000000000000&configureFields=1');
    await import('../public/technical-review.js?missing-config-link-' + page);
    await waitFor(() => get('question-rows').children.length === 1 && !get('refresh-datasets').disabled);
    assert.equal(get('dataset-select').value, distractor.id); assert.equal(!!get('review-fields-dialog').open, false); assert.equal(replacements, 1);
  }
});

test('冻结页真实表头事件支持继承描述、多选和组合筛选，配置变更及切换版本清理失效筛选', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'frozen-fields-ui-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { throw new Error('No model call expected'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout, timers = [];
  const previous = Object.fromEntries(['document', 'Option', 'location', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimer; timers.forEach(clearTimeout);
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options);
  globalThis.setTimeout = (...args) => { const timer = nativeTimer(...args); timers.push(timer); return timer; };
  globalThis.Option = OptionElement;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  const api = async (route, method = 'GET', body) => (await fetch(route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })).json();
  const records = [['A', '铁矿石'], ['B', '铁矿石'], ['C', '钢铁'], ['A', '钢铁']].map(([type, domain], index) => ({ type, domain, question: '问题' + (index + 1), answer: '答案' + (index + 1) }));
  const dataset = (await api('/api/technical-reviews?name=frozen-fields.json', 'POST', records)).dataset;
  const v1 = (await api('/api/frozen-versions', 'POST', { name: '多分类版本' })).version, v2 = (await api('/api/frozen-versions', 'POST', { name: '切换版本' })).version;
  await api('/api/technical-reviews/' + dataset.id + '/batch', 'POST', { action: 'approve', versionId: v1.id, questions: records.map((_, index) => ({ number: index + 1, revision: 'original' })) });
  await api('/api/technical-reviews/' + dataset.id + '/questions/1/approve', 'POST', { revision: 'original', versionId: v2.id });
  const saved = await api('/api/expert-reviews/' + dataset.id + '/fields', 'PUT', { revision: 'none', fields: [{ key: 'type', description: '题型说明', filterable: true }, { key: 'domain', description: '业务领域', filterable: true }] });
  const dom = documentFor(await readFile(new URL('../public/frozen-datasets.html', import.meta.url), 'utf8')), get = dom.get;
  globalThis.document = dom.document; globalThis.location = new URL(url + '/frozen-datasets?version=' + v1.id);
  await import('../public/frozen-datasets.js?frozen-fields-test');
  await waitFor(() => get('frozen-rows').children.length === 4);
  const header = key => find(get('frozen-table-head'), element => element.getAttribute('aria-label') === '筛选字段：' + key);
  assert.ok(get('frozen-table-head').textContent.includes('题型说明'));
  const choose = async label => { const checkbox = find(get('review-field-values'), element => element.getAttribute('aria-label') === '选择分类：' + label); assert.ok(checkbox); checkbox.checked = true; await checkbox.dispatch('change'); };
  await header('type').dispatch('click'); await choose('A'); await choose('B');
  await get('apply-review-field-filter').dispatch('click'); assert.equal(get('frozen-rows').children.length, 3);
  await header('domain').dispatch('click'); await choose('铁矿石');
  await get('apply-review-field-filter').dispatch('click'); assert.equal(get('frozen-rows').children.length, 2);
  assert.equal(get('review-field-chips').hidden, false);
  await find(get('frozen-rows'), element => element.getAttribute('aria-label') === '删除冻结第 2 题').dispatch('click');
  await get('delete-frozen-question-form').dispatch('submit');
  assert.equal(get('frozen-rows').children.length, 1); assert.ok(get('version-cards').textContent.includes('3 题'));
  await header('type').dispatch('click'); assert.ok(get('review-field-values').textContent.includes('A'));
  await get('cancel-review-field-filter').dispatch('click');
  await api('/api/technical-reviews/' + dataset.id + '/fields', 'PUT', { revision: saved.revision, fields: [{ key: 'domain', description: '业务领域', filterable: true }] });
  get('frozen-page-size').value = '50'; await get('frozen-page-size').dispatch('change');
  await waitFor(() => get('frozen-rows').children.length === 3 && get('review-field-chips').hidden);
  assert.equal(header('type'), undefined);
  await header('domain').dispatch('click'); await choose('钢铁'); await get('apply-review-field-filter').dispatch('click');
  assert.equal(get('frozen-rows').children.length, 2);
  await get('version-cards').children.find(card => card.textContent.includes('切换版本')).dispatch('click');
  assert.equal(get('review-field-chips').hidden, true); assert.equal(get('frozen-rows').children.length, 1);
  assert.deepEqual((await api('/api/frozen-versions/' + v1.id + '/download')), [records[0], records[2], records[3]]);
});

test('两个审核页通过实际上传事件导入 JSONL，自动配置字段、展示详情并切回 JSON', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-jsonl-ui-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { throw new Error('No model call expected'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout, timers = [];
  const previous = Object.fromEntries(['document', 'Option', 'location', 'navigator', 'XMLHttpRequest'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimer; timers.forEach(clearTimeout);
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options);
  globalThis.setTimeout = (...args) => { const timer = nativeTimer(...args); timers.push(timer); return timer; };
  globalThis.Option = OptionElement;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  // Transport test double forwards the page's unmodified Blob to the actual upload API.
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; }
    open(method, route) { this.method = method; this.route = route; }
    setRequestHeader(key, value) { this.headers[key] = value; }
    send(file) {
      fetch(this.route, { method: this.method, headers: this.headers, body: file }).then(async response => {
        this.status = response.status; this.responseText = await response.text(); this.onload();
      }).catch(() => this.onerror());
    }
  };
  const records = [{ question: '第一题', answer: '答案', custom: false }, { question: '第二题', answer: '答案二', extra: { 满分: 5 } }];
  for (const page of ['expert-review', 'technical-review']) {
    const dom = documentFor(await readFile(new URL('../public/' + page + '.html', import.meta.url), 'utf8')), get = dom.get;
    globalThis.document = dom.document; globalThis.location = new URL(url + '/' + page);
    await import('../public/technical-review.js?jsonl-ui-' + page);
    await waitFor(() => page === 'expert-review' ? !get('review-empty').hidden : get('question-rows').children.length === 1);
    const file = Object.assign(new Blob([records.map(item => JSON.stringify(item)).join('\n') + '\n'], { type: 'application/x-ndjson' }), { name: page + '.jsonl' });
    get('dataset-input').files = [file]; await get('dataset-input').dispatch('change');
    await waitFor(() => get('review-fields-dialog').open && get('review-fields-rows').textContent.includes('extra') && get('question-rows').children.length === 2);
    assert.ok(get('review-fields-rows').textContent.includes('extra'));
    assert.equal(get('download-dataset').textContent, '下载原始 JSONL');
    await get('cancel-review-fields').dispatch('click');
    await find(get('question-rows'), element => element.getAttribute('aria-label') === '第 2 题详情').dispatch('click');
    assert.deepEqual(JSON.parse(get('question-json').value), records[1]);
    await get('close-question').dispatch('click');
    get('dataset-input').files = [Object.assign(new Blob([JSON.stringify([records[0]])]), { name: page + '.json' })];
    await get('dataset-input').dispatch('change');
    await waitFor(() => get('review-fields-dialog').open && get('review-fields-rows').children.length > 0 && get('question-rows').children.length === 1);
    assert.equal(get('download-dataset').textContent, '下载原始 JSON');
    await get('cancel-review-fields').dispatch('click');
  }
});

test('审核页真实事件完成修改、删除、创建版本与通过，冻结页可查看快照并创建新版本', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-ui-test-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port; const nativeFetch = globalThis.fetch; const nativeTimer = globalThis.setTimeout; const timers = [];
  const previous = Object.fromEntries(['document', 'Option', 'location', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimer; timers.forEach(clearTimeout);
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options);
  globalThis.setTimeout = (...args) => { const timer = nativeTimer(...args); timers.push(timer); return timer; };
  globalThis.Option = OptionElement; globalThis.location = new URL(url);
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } });
  const records = [1, 2, 3].map(n => ({ Question: '完整问题' + n, 'User Question': '用户问题' + n, 'SELECT Data': null, answer: '答案' + n, 'Scoring criteria': { 满分: 5, 细则: [{ 得分: 5 }] }, difficulty: '易', 'Task family': 'A 点查', source: 'IO-' + n }));
  assert.equal((await fetch('/api/technical-reviews?name=demo.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(records) })).status, 201);
  let dom = documentFor(await readFile(new URL('../public/technical-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document;
  let get = dom.get;
  await import('../public/technical-review.js');
  await waitFor(() => get('question-rows').children.length === 3);
  await find(get('question-rows'), element => element.getAttribute('aria-label') === '第 1 题详情').dispatch('click');
  assert.equal(get('question-detail').open, true); assert.equal(JSON.parse(get('question-json').value).answer, '答案1');
  await get('edit-question').dispatch('click');
  const answerField = get('edit-fields').children.find(field => field.children[0].textContent.startsWith('answer ·')).children[1];
  answerField.value = '审核修订的标准答案';
  const selectField = get('edit-fields').children.find(field => field.children[0].textContent.startsWith('SELECT Data ·')).children[1];
  selectField.value = '{ invalid JSON';
  await get('question-edit-form').dispatch('submit'); assert.equal(get('edit-question-error').hidden, false); assert.equal(get('question-editor').open, true);
  selectField.value = '{"报价":685,"原始值":[null,0,false]}';
  await get('edit-json-mode').dispatch('click');
  const edited = JSON.parse(get('edit-question-json').value); edited.自定义字段 = { 保留: false }; get('edit-question-json').value = JSON.stringify(edited);
  await get('edit-fields-mode').dispatch('click'); await get('question-edit-form').dispatch('submit');
  assert.equal(get('question-editor').open, false); assert.equal(JSON.parse(get('question-json').value).answer, '审核修订的标准答案');
  await get('approve-question').dispatch('click');
  assert.equal(get('approval-version').value, '__new__'); get('approval-version-name').value = '界面审核 v1';
  await get('approve-question-form').dispatch('submit');
  assert.equal(get('question-detail').open, false); assert.equal(get('question-rows').children.length, 2); assert.equal(get('stat-approved').textContent, '1');
  const selectedVersion = (await (await fetch('/api/frozen-versions')).json()).versions[0];
  await find(get('question-rows'), element => element.getAttribute('aria-label') === '第 3 题详情').dispatch('click');
  await get('approve-question').dispatch('click');
  get('approval-version').value = selectedVersion.id; await get('approval-version').dispatch('change');
  assert.equal(get('new-approval-version').hidden, true); await get('approve-question-form').dispatch('submit');
  assert.equal(get('stat-approved').textContent, '2');
  await find(get('question-rows'), element => element.getAttribute('aria-label') === '第 2 题详情').dispatch('click');
  await get('delete-question').dispatch('click'); await get('confirm-delete-question').dispatch('click');
  assert.equal(get('question-rows').children.length, 0); assert.ok(get('stat-deleted').textContent.includes('1'));

  // Select across pages, select/deselect only one page, and operate on all filtered results.
  const batchRecords = Array.from({ length: 44 }, (_, index) => ({ ...records[0], Question: '批量题目' + (index + 1), 'User Question': '批量用户问题' + (index + 1), answer: '批量答案' + (index + 1), difficulty: index % 2 ? '难' : '易', source: 'BATCH-' + (index + 1) }));
  const imported = await (await fetch('/api/technical-reviews?name=batch-ui.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(batchRecords) })).json();
  await get('refresh-datasets').dispatch('click');
  get('dataset-select').value = imported.dataset.id; await get('dataset-select').dispatch('change');
  await waitFor(() => get('question-rows').children.length === 20);
  const choose = async (number, checked = true) => { const input = find(get('question-rows'), element => element.getAttribute('aria-label') === '选择第 ' + number + ' 题'); assert.ok(input); input.checked = checked; await input.dispatch('change'); };
  const search = async (text, total) => { get('question-search').value = text; await get('question-search').dispatch('input'); await waitFor(() => get('question-range').textContent.startsWith('共 ' + total + ' 题')); };
  await choose(1); assert.equal(get('select-page-questions').indeterminate, true);
  await search('易', 22);
  assert.equal(get('selection-count').textContent, '已选择 0 题');
  await waitFor(() => get('question-rows').children.length === 20);
  await search('', 44);
  await waitFor(() => get('question-rows').children.length === 20);
  await choose(1); await get('next-page').dispatch('click');
  await waitFor(() => !!find(get('question-rows'), element => element.getAttribute('aria-label') === '选择第 21 题'));
  await choose(21); assert.equal(get('selection-count').textContent, '已选择 2 题');
  get('select-page-questions').checked = true; await get('select-page-questions').dispatch('change');
  assert.equal(get('selection-count').textContent, '已选择 21 题');
  get('select-page-questions').checked = false; await get('select-page-questions').dispatch('change');
  assert.equal(get('selection-count').textContent, '已选择 1 题'); await choose(21);
  await get('batch-approve-questions').dispatch('click');
  get('approval-version').value = '__new__'; await get('approval-version').dispatch('change'); get('approval-version-name').value = '批量版本';
  await get('approve-question-form').dispatch('submit');
  assert.equal(get('stat-approved').textContent, '2'); assert.equal(get('selection-count').textContent, '已选择 0 题');
  const batchVersion = (await (await fetch('/api/frozen-versions')).json()).versions.find(version => version.name === '批量版本');
  assert.deepEqual(await (await fetch('/api/frozen-versions/' + batchVersion.id + '/download')).json(), [batchRecords[0], batchRecords[20]]);
  await search('难', 22);
  await waitFor(() => get('question-rows').children.length === 20);
  await get('select-filtered-questions').dispatch('click');
  assert.equal(get('selection-count').textContent, '已选择 22 题');
  get('question-search').value = '批量用户问题44'; await get('question-search').dispatch('input');
  assert.equal(get('selection-count').textContent, '已选择 0 题');
  await waitFor(() => get('question-rows').children.length === 1);
  await get('select-filtered-questions').dispatch('click'); assert.equal(get('selection-count').textContent, '已选择 1 题');
  await search('难', 22);
  await waitFor(() => get('question-rows').children.length === 20);
  await get('select-filtered-questions').dispatch('click');
  assert.equal(get('selection-count').textContent, '已选择 22 题');
  await get('batch-approve-questions').dispatch('click'); get('approval-version').value = batchVersion.id;
  await get('approval-version').dispatch('change'); await get('approve-question-form').dispatch('submit');
  assert.equal(get('stat-approved').textContent, '24'); assert.equal(get('question-rows').children.length, 0);
  await search('易', 20);
  await waitFor(() => get('question-rows').children.length === 20);
  get('select-page-questions').checked = true; await get('select-page-questions').dispatch('change');
  await get('batch-delete-questions').dispatch('click'); assert.ok(get('delete-question-title').textContent.includes('20'));
  await get('cancel-delete-question').dispatch('click'); assert.equal(get('selection-count').textContent, '已选择 20 题');
  await get('batch-delete-questions').dispatch('click'); await get('confirm-delete-question').dispatch('click');
  assert.equal(get('question-rows').children.length, 0); assert.equal(get('selection-count').textContent, '已选择 0 题'); assert.ok(get('stat-deleted').textContent.includes('20'));
  assert.equal((await (await fetch('/api/frozen-versions/' + batchVersion.id + '/questions')).json()).total, 24);
  globalThis.location.search = '?version=' + selectedVersion.id;
  dom = documentFor(await readFile(new URL('../public/frozen-datasets.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/frozen-datasets.js');
  await waitFor(() => get('frozen-rows').children.length === 2);
  await find(get('frozen-rows'), element => element.getAttribute('aria-label') === '冻结第 1 题详情').dispatch('click');
  assert.deepEqual(JSON.parse(get('frozen-question-json').value), edited); assert.equal(get('frozen-detail').open, true);
  await get('close-frozen-detail').dispatch('click'); await get('create-version').dispatch('click');
  get('version-name').value = '手动创建 v2'; get('version-description').value = '第二个版本'; await get('create-version-form').dispatch('submit');
  assert.equal(get('version-cards').children.length, 3); assert.equal(get('active-version-name').textContent, '手动创建 v2'); assert.equal(get('frozen-rows').children.length, 0);
  assert.ok(get('export-version').href.endsWith('/download')); assert.equal(get('frozen-questions-empty').hidden, false);

  // Cancellation preserves the version; deletion selects another existing version.
  await get('delete-version').dispatch('click');
  assert.equal(get('delete-version-dialog').open, true); assert.match(get('delete-version-summary').textContent, /手动创建 v2.*0 道题/);
  await get('cancel-delete-version').dispatch('click');
  assert.equal(get('version-cards').children.length, 3);
  await get('delete-version').dispatch('click'); await get('delete-version-form').dispatch('submit');
  assert.equal(get('delete-version-dialog').open, false); assert.equal(get('version-cards').children.length, 2);
  assert.equal(get('frozen-workspace').hidden, false);
  await find(get('version-cards'), element => element.tagName === 'BUTTON' && element.textContent.includes('批量版本')).dispatch('click');
  await get('delete-version').dispatch('click'); assert.match(get('delete-version-summary').textContent, /24 道题/);
  await get('delete-version-form').dispatch('submit');
  assert.equal(get('version-cards').children.length, 1); assert.equal(get('active-version-name').textContent, selectedVersion.name);
  assert.equal(get('frozen-rows').children.length, 2);

  // Business experts use the same dataset, save private drafts, then submit advice to technicians.
  const sharedDataset = (await (await fetch('/api/technical-reviews')).json()).datasets.find(dataset => dataset.name === 'demo.json');
  globalThis.location.search = '?dataset=' + sharedDataset.id + '&question=1';
  dom = documentFor(await readFile(new URL('../public/expert-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/technical-review.js?expert-review-test');
  await waitFor(() => get('question-detail').open && JSON.parse(get('question-json').value || '{}').answer === edited.answer && !get('expert-advice-text').disabled);
  assert.equal(get('dataset-select').value, sharedDataset.id); assert.equal(get('status-filter').value, '');
  const advice1 = '请补充含税口径和计价单位。\n<script>这里只是建议原文</script>';
  get('expert-advice-text').value = advice1; await get('expert-advice-text').dispatch('input');
  assert.equal(get('save-expert-draft').disabled, false); await get('save-expert-draft').dispatch('click');
  assert.ok(get('expert-draft-status').textContent.includes('草稿已保存'));
  let technicianRecord = await (await fetch('/api/technical-reviews/' + sharedDataset.id + '/questions/1')).json();
  assert.equal(technicianRecord.expertAdvice, null); assert.deepEqual(technicianRecord.record, edited);
  await get('submit-expert-advice').dispatch('click');
  assert.ok(get('expert-draft-status').textContent.includes('已提交给技术人员')); assert.equal(get('submit-expert-advice').disabled, true);
  technicianRecord = await (await fetch('/api/technical-reviews/' + sharedDataset.id + '/questions/1')).json();
  assert.equal(technicianRecord.expertAdvice.text, advice1); assert.equal(technicianRecord.summary.status, 'pending');
  assert.ok(get('expert-open-technical').href.includes('dataset=' + sharedDataset.id));
  get('expert-advice-text').value = '第二次建议：补充日期说明'; await get('expert-advice-text').dispatch('input'); await get('submit-expert-advice').dispatch('click');
  assert.equal(get('expert-advice-history').children.length, 2);
  get('expert-advice-text').value = '第三次建议：重写评分标准'; await get('expert-advice-text').dispatch('input'); await get('save-expert-draft').dispatch('click');
  await get('next-question').dispatch('click');
  await waitFor(() => JSON.parse(get('question-json').value || '{}').source === records[2].source && !get('expert-advice-text').disabled);
  assert.equal(JSON.parse(get('question-json').value).source, records[2].source);
  get('expert-advice-text').value = '第 3 题建议：核对参考答案'; await get('expert-advice-text').dispatch('input');
  await get('close-question').dispatch('click');
  await find(get('question-rows'), element => element.getAttribute('aria-label') === '第 3 题详情').dispatch('click');
  assert.equal(get('expert-advice-text').value, '第 3 题建议：核对参考答案');
  await get('save-expert-draft').dispatch('click'); await get('close-question').dispatch('click');
  get('expert-status-filter').value = 'draft'; await get('expert-status-filter').dispatch('change');
  await waitFor(() => get('question-rows').children.length === 2);
  await get('select-filtered-questions').dispatch('click'); assert.equal(get('selection-count').textContent, '已选择 2 题');
  await get('batch-submit-expert').dispatch('click');
  assert.equal(get('selection-count').textContent, '已选择 0 题'); assert.equal(get('question-rows').children.length, 0);
  technicianRecord = await (await fetch('/api/technical-reviews/' + sharedDataset.id + '/questions/1')).json();
  assert.equal(technicianRecord.expertAdvice.text, '第三次建议：重写评分标准');
  assert.equal(technicianRecord.expertAdvice.history.length, 3);
  assert.deepEqual(await (await fetch('/api/frozen-versions/' + selectedVersion.id + '/download')).json(), [edited, records[2]]);
  globalThis.location.search = '?dataset=' + sharedDataset.id + '&question=1';
  dom = documentFor(await readFile(new URL('../public/technical-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/technical-review.js?technician-advice-test');
  await waitFor(() => get('question-detail').open && get('fields-panel').textContent.includes('第三次建议：重写评分标准'));
  assert.ok(get('fields-panel').children[0].textContent.includes('专家建议'));
  assert.ok(get('question-rows').textContent.includes('第三次建议：重写评分标准'));
  assert.deepEqual(JSON.parse(get('question-json').value), edited);
  await get('close-question').dispatch('click');
  get('advice-filter').value = 'with'; await get('advice-filter').dispatch('change');
  await waitFor(() => get('question-rows').children.length === 2);
  assert.ok(get('question-rows').textContent.includes('第 3 题建议：核对参考答案'));

  // Both review pages use original JSON keys, including heterogeneous and structured fields.
  const dynamicRecords = [{ id: 'CPT001', type: '单选', question: '从选项中选择答案', options: { A: '甲', B: '乙' }, response_unit: null, flag: false, count: 0, 专家建议: '原 JSON 的自定义字段' }, { question: '第二题', answer: '答案', extra: '<script>仅作为字段值</script>' }];
  const dynamicUpload = await (await fetch('/api/technical-reviews?name=columns.json', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(dynamicRecords) })).json();
  globalThis.location.search = '?dataset=' + dynamicUpload.dataset.id;
  dom = documentFor(await readFile(new URL('../public/technical-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/technical-review.js?dynamic-columns-test');
  await waitFor(() => get('question-rows').children.length === 2);
  const dynamicKeys = [...Object.keys(dynamicRecords[0]), 'answer', 'extra'];
  assert.deepEqual(get('review-table-head').children.slice(2, -3).map(element => element.textContent), dynamicKeys);
  assert.equal(get('review-table-head').children.at(-3).textContent, '专家建议（审核）');
  assert.equal(get('question-rows').children[0].children.length, dynamicKeys.length + 5);
  assert.equal(get('question-rows').children[0].children[6].textContent, 'null');
  assert.equal(get('question-rows').children[0].children[7].textContent, 'false');
  assert.equal(get('question-rows').children[0].children[8].textContent, '0');
  assert.equal(get('question-rows').children[1].children[2].textContent, '—');
  get('select-page-questions').checked = true; await get('select-page-questions').dispatch('change');
  assert.equal(get('selection-count').textContent, '已选择 2 题');
  await find(get('question-rows'), element => element.getAttribute('aria-label') === '查看第 1 题').dispatch('click');
  assert.deepEqual(JSON.parse(get('question-json').value), dynamicRecords[0]);
  await get('close-question').dispatch('click');
  globalThis.location.search = '?dataset=' + dynamicUpload.dataset.id;
  dom = documentFor(await readFile(new URL('../public/expert-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/technical-review.js?expert-dynamic-columns-test');
  await waitFor(() => get('question-rows').children.length === 2);
  assert.deepEqual(get('review-table-head').children.slice(2, -3).map(element => element.textContent), dynamicKeys);
  assert.equal(get('review-table-head').children.at(-2).textContent, '建议状态');
  assert.ok(get('question-rows').textContent.includes('<script>仅作为字段值</script>'));

  // Configure actual JSON keys and filter directly from the shared expert table headers.
  const filterKey = dynamicKeys[0];
  await get('configure-review-fields').dispatch('click');
  assert.equal(get('review-fields-dialog').open, true);
  const description = find(get('review-fields-rows'), element => element.getAttribute('aria-label') === '字段描述：' + filterKey);
  const enabled = find(get('review-fields-rows'), element => element.getAttribute('aria-label') === '启用分类筛选：' + filterKey);
  assert.ok(description); assert.ok(enabled);
  description.value = '字段含义 <script>保持文本</script>'; enabled.checked = true;
  await get('review-fields-form').dispatch('submit');
  assert.equal(get('review-fields-dialog').open, false);
  const fieldHeader = () => find(get('review-table-head'), element => element.getAttribute('aria-label') === '筛选字段：' + filterKey);
  assert.ok(fieldHeader());
  await fieldHeader().dispatch('click');
  assert.equal(get('review-field-filter-dialog').open, true);
  assert.ok(get('review-field-filter-description').textContent.includes(description.value));
  assert.ok(get('review-field-values').children.length > 0);
  const firstCategory = get('review-field-values').children[0].children[0]; firstCategory.checked = true; await firstCategory.dispatch('change');
  await get('apply-review-field-filter').dispatch('click');
  assert.equal(get('review-field-filter-dialog').open, false); assert.equal(get('review-field-chips').hidden, false);
  assert.equal(get('question-rows').children.length, 1);
  await get('select-filtered-questions').dispatch('click'); assert.equal(get('selection-count').textContent, '已选择 1 题');
  await fieldHeader().dispatch('click');
  assert.equal(get('review-field-values').children[0].children[0].checked, true);
  get('select-review-field-page').checked = true; await get('select-review-field-page').dispatch('change');
  assert.equal(get('review-field-selected-count').textContent, '已选择 2 个分类');
  await get('apply-review-field-filter').dispatch('click');
  assert.equal(get('question-rows').children.length, 2);
  await fieldHeader().dispatch('click'); await get('clear-review-field-selection').dispatch('click'); await get('cancel-review-field-filter').dispatch('click');
  assert.equal(get('question-rows').children.length, 2); assert.equal(get('review-field-chips').hidden, false);
  await get('configure-review-fields').dispatch('click');
  find(get('review-fields-rows'), element => element.getAttribute('aria-label') === '启用分类筛选：' + filterKey).checked = false;
  await get('review-fields-form').dispatch('submit');
  assert.equal(get('review-field-chips').hidden, true); assert.equal(get('question-rows').children.length, 2); assert.equal(get('selection-count').textContent, '已选择 0 题'); assert.equal(fieldHeader(), undefined);
  const sharedFields = await (await fetch('/api/technical-reviews/' + dynamicUpload.dataset.id + '/fields')).json();
  assert.equal(sharedFields.fields.find(field => field.key === filterKey).description, description.value);

  // Delete the selected import from either review page, with cancellation and empty-state handling.
  await get('delete-dataset').dispatch('click');
  assert.equal(get('delete-dataset-dialog').open, true); assert.match(get('delete-dataset-summary').textContent, /columns.json/);
  assert.match(get('delete-dataset-count').textContent, /当前 2 题/);
  await get('cancel-delete-dataset').dispatch('click');
  assert.equal(get('dataset-select').value, dynamicUpload.dataset.id);
  await get('delete-dataset').dispatch('click'); await get('delete-dataset-form').dispatch('submit');
  assert.equal(get('delete-dataset-dialog').open, false);
  assert.ok(!get('dataset-select').options.some(option => option.value === dynamicUpload.dataset.id));
  globalThis.location.search = '?dataset=' + dynamicUpload.dataset.id;
  dom = documentFor(await readFile(new URL('../public/technical-review.html', import.meta.url), 'utf8')); globalThis.document = dom.document; get = dom.get;
  await import('../public/technical-review.js?delete-dataset-test');
  await waitFor(() => get('dataset-select').options.length === 2);
  assert.ok(!get('dataset-select').options.some(option => option.value === dynamicUpload.dataset.id));
  for (let remaining = 2; remaining > 0; remaining--) {
    await get('delete-dataset').dispatch('click'); await get('delete-dataset-form').dispatch('submit');
    assert.equal((await (await fetch('/api/technical-reviews')).json()).datasets.length, remaining - 1);
  }
  assert.equal(get('review-empty').hidden, false); assert.equal(get('dataset-workspace').hidden, true);
  assert.equal(get('delete-dataset').hidden, true); assert.equal(get('download-dataset').hidden, true); assert.equal(get('dataset-select').disabled, true);
  assert.deepEqual(await (await fetch('/api/frozen-versions/' + selectedVersion.id + '/download')).json(), [edited, records[2]]);
});
