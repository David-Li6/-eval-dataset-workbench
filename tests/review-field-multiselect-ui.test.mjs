// Test actual checkbox events and API calls; this is not a browser layout test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';
import { initReviewFields } from '../public/review-fields.js';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async dispatch(type) { for (const callback of this.listeners.get(type) || []) await callback({ preventDefault() {} }); }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
async function waitFor(check) { const deadline = Date.now() + 5000; while (!check()) { if (Date.now() > deadline) throw new Error('UI did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }

test('多选跨搜索和分页保留，取消不生效，全选本页不会丢失其他页，清空后应用解除筛选', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'review-multi-ui-'));
  const server = createAppServer({ configPath: path.join(directory, 'config.json') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port, nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout, previousDocument = globalThis.document, timers = [];
  t.after(async () => { globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimer; if (previousDocument) globalThis.document = previousDocument; else delete globalThis.document; timers.forEach(clearTimeout); await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true }); });
  const api = async (route, method = 'GET', body) => (await nativeFetch(url + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })).json();
  const records = Array.from({ length: 135 }, (_, index) => ({ Question: '问题' + index, answer: '答案' + index, category: '分类' + String(index).padStart(3, '0') }));
  let dataset = (await api('/api/technical-reviews?name=multi.json', 'POST', records)).dataset;
  const endpoint = '/api/technical-reviews', route = endpoint + '/' + dataset.id;
  dataset = (await api(route + '/fields', 'PUT', { revision: 'none', fields: [{ key: 'category', description: '', filterable: true }] })).dataset;
  const elements = new Map();
  for (const match of (await readFile(new URL('../public/technical-review.html', import.meta.url), 'utf8')).matchAll(/<([\w-]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) elements.set(match[2], new Element(match[1]));
  const get = id => { assert.ok(elements.has(id), id); return elements.get(id); };
  globalThis.document = { getElementById: get, createElement: tag => new Element(tag) };
  globalThis.fetch = (route, options) => nativeFetch(new URL(route, url), options);
  globalThis.setTimeout = (...args) => { const timer = nativeTimer(...args); timers.push(timer); return timer; };
  let filteredCount = 135, tools;
  tools = initReviewFields({ endpoint, getDataset: () => dataset, isBusy: () => false, notify() {}, onSaved() {}, async onFilterChanged() { filteredCount = (await api(route + '/questions?' + new URLSearchParams(tools.getFilters()))).total; } });
  tools.update(dataset);
  const heading = new Element('th'); tools.decorateHeading(heading, 'category');
  const open = () => heading.children[0].dispatch('click');
  const checkbox = index => get('review-field-values').children[index].children[0];
  const choose = async index => { checkbox(index).checked = true; await checkbox(index).dispatch('change'); };
  await open(); assert.equal(get('review-field-values').children.length, 100); await choose(0);
  await get('review-field-options-next').dispatch('click'); assert.equal(get('review-field-values').children.length, 35); await choose(0);
  await get('review-field-options-prev').dispatch('click'); assert.equal(checkbox(0).checked, true); assert.equal(get('review-field-selected-count').textContent, '已选择 2 个分类');
  get('review-field-options-search').value = '分类134'; await get('review-field-options-search').dispatch('input');
  await waitFor(() => get('review-field-values').children.length === 1); await choose(0);
  assert.equal(get('review-field-selected-count').textContent, '已选择 3 个分类');
  await get('cancel-review-field-filter').dispatch('click'); assert.deepEqual(tools.getFilters(), {});
  await open(); get('select-review-field-page').checked = true; await get('select-review-field-page').dispatch('change');
  await get('review-field-options-next').dispatch('click'); await choose(0);
  assert.equal(get('review-field-selected-count').textContent, '已选择 101 个分类');
  get('review-field-options-search').value = '没有这样的分类'; await get('review-field-options-search').dispatch('input');
  await waitFor(() => get('review-field-values').children.length === 0 && !get('apply-review-field-filter').disabled);
  assert.equal(get('review-field-selected-count').textContent, '已选择 101 个分类');
  await get('apply-review-field-filter').dispatch('click'); assert.equal(filteredCount, 101);
  const applied = tools.getFilters();
  await open(); assert.equal(checkbox(0).checked, true); await get('clear-review-field-selection').dispatch('click'); assert.equal(get('review-field-selected-count').textContent, '已选择 0 个分类');
  await get('cancel-review-field-filter').dispatch('click'); assert.deepEqual(tools.getFilters(), applied);
  await open(); await get('clear-review-field-selection').dispatch('click'); await get('apply-review-field-filter').dispatch('click'); assert.equal(filteredCount, 135); assert.deepEqual(tools.getFilters(), {});
});
