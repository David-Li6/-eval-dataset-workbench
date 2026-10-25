// Exercise distribution controls using the real page markup and local API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { initReviewDistribution } from '../public/review-distribution.js';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.hidden = false; this.disabled = false; this._value = ''; this._text = ''; this.style = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set value(value) { this._value = this.tagName === 'SELECT' && !this.children.some(option => option.value === String(value)) ? '' : String(value); }
  get value() { return this._value; }
  get options() { return this.children; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; if (this.tagName === 'SELECT') this._value = children[0]?.value || ''; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async dispatch(type) { for (const callback of this.listeners.get(type) || []) await callback({ preventDefault() {} }); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
}
class OptionElement extends Element { constructor(text, value) { super('option'); this.textContent = text; this.value = value; } }
function documentFor(html) {
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) { const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[2]); elements.set(match[3], element); }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) elements.get(match[1]).replaceChildren(...[...match[2].matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)].map(option => new OptionElement(option[2], option[1])));
  return { get: id => { assert.ok(elements.has(id), id); return elements.get(id); }, document: { getElementById: id => elements.get(id), createElement: tag => new Element(tag) } };
}
function find(root, predicate) { if (predicate(root)) return root; for (const child of root.children) { const result = find(child, predicate); if (result) return result; } }

test('三个页面可选择单字段或双字段，图表分类分页、范围切换和空样本正确，迟到统计不覆盖新选择', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'distribution-ui-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), fetchImpl: async () => { throw new Error('No model call expected'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, nativeFetch = globalThis.fetch;
  const previous = Object.fromEntries(['document', 'Option'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch;
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options); globalThis.Option = OptionElement;
  const request = async (route, method = 'GET', body) => (await fetch(route, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })).json();
  const records = Array.from({ length: 46 }, (_, index) => ({ question: '问题' + (index + 1), answer: '答案', category: '分类' + String(index % 23).padStart(2, '0'), domain: index % 2 ? '钢铁' : '矿石' }));
  const imported = (await request('/api/technical-reviews?name=chart-ui.json', 'POST', records)).dataset;
  await request('/api/technical-reviews/' + imported.id + '/fields', 'PUT', { revision: 'none', fields: ['category', 'domain'].map(key => ({ key, description: '', filterable: true })) });
  const version = (await request('/api/frozen-versions', 'POST', { name: '图表版本' })).version;
  await request('/api/technical-reviews/' + imported.id + '/batch', 'POST', { action: 'approve', versionId: version.id, questions: records.map((_, index) => ({ number: index + 1, revision: 'original' })) });
  for (const [page, endpoint, id] of [['technical-review', '/api/technical-reviews', imported.id], ['expert-review', '/api/expert-reviews', imported.id], ['frozen-datasets', '/api/frozen-versions', version.id]]) {
    const dom = documentFor(await readFile(new URL('../public/' + page + '.html', import.meta.url), 'utf8')), get = dom.get; globalThis.document = dom.document;
    let dataset = (await request(endpoint + '/' + id)).dataset, filters = {};
    const tools = initReviewDistribution({ endpoint, getDataset: () => dataset, getFilters: () => filters });
    await tools.update(dataset); assert.equal(get('distribution-first').disabled, false); assert.equal(get('distribution-result').children.length, 0);
    const select = async (control, key) => { const option = get(control).options.find(option => option.textContent === key); assert.ok(option, key); get(control).value = option.value; await get(control).dispatch('change'); };
    await select('distribution-first', 'category');
    assert.ok(get('distribution-result').textContent.includes('总样本 n=46'));
    const chart = () => get('distribution-result').children[0];
    const bars = () => find(chart(), element => element.className === 'distribution-bars');
    assert.equal(bars().children.length, 20); assert.ok(bars().children[0].textContent.includes('2题4.3%'));
    assert.equal(bars().children[0].children[1].children[0].style.width, '100%');
    await find(chart(), element => element.attributes.get('aria-label') === '分类下一页').dispatch('click'); assert.equal(bars().children.length, 3);
    await select('distribution-second', 'domain');
    const matrix = () => find(chart(), element => element.className === 'distribution-matrix');
    assert.ok(matrix()); assert.equal(matrix().children[1].children.length, 20); assert.ok(matrix().textContent.includes('总计 46题'));
    assert.equal(get('distribution-second').options.some(option => option.textContent === 'category'), false);
    await find(chart(), element => element.attributes.get('aria-label') === '行分类下一页').dispatch('click'); assert.equal(matrix().children[1].children.length, 3);
    filters = { query: '问题46' }; await tools.update(dataset);
    assert.ok(chart().textContent.includes('总样本 n=1')); assert.equal(matrix().children[1].children.length, 1);
    get('distribution-scope').value = 'all'; await get('distribution-scope').dispatch('change'); assert.ok(chart().textContent.includes('总样本 n=46'));
    get('distribution-scope').value = 'filtered'; filters = { query: '不匹配的结果' }; await get('distribution-scope').dispatch('change');
    assert.ok(chart().textContent.includes('总样本 n=0')); assert.equal(find(chart(), element => element.className === 'distribution-matrix'), undefined);
    dataset = { ...dataset, fieldSettings: dataset.fieldSettings.map(field => ({ ...field, filterable: field.key === 'domain' })) }; await tools.update(dataset);
    assert.equal(get('distribution-result').children.length, 0); assert.equal(get('distribution-second').disabled, true);
    // A transport that finishes after cancellation must not resurrect a previous chart.
    const baselineFetch = globalThis.fetch; let release;
    globalThis.fetch = (route, options) => String(route).includes('/distribution?') ? new Promise(resolve => { release = () => baselineFetch(route, { ...options, signal: undefined }).then(resolve); }) : baselineFetch(route, options);
    const option = get('distribution-first').options.find(option => option.textContent === 'domain'); get('distribution-first').value = option.value;
    const pending = get('distribution-first').dispatch('change'); assert.ok(release);
    get('distribution-first').value = ''; await get('distribution-first').dispatch('change');
    await release(); await pending; globalThis.fetch = baselineFetch;
    assert.equal(get('distribution-result').children.length, 0); tools.reset();
  }
});
