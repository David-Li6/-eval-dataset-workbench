// Exercise actual page events with an isolated API and a DOM test double.
// This verifies interaction logic, not browser layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createAppServer } from '../server.mjs';

class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.listeners = new Map(); this.attributes = new Map(); this.hidden = false; this.disabled = false; this.value = ''; this._text = ''; this.style = {}; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, callback) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(callback); }
  async dispatch(type) { for (const listener of this.listeners.get(type) || []) await listener({ preventDefault() {}, target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function documentFor(html) {
  const elements = new Map();
  for (const match of html.matchAll(/<([\w-]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) { const element = new Element(match[1]); element.hidden = /\bhidden\b/.test(match[2]); elements.set(match[3], element); }
  const document = new Element('document'); document.getElementById = id => elements.get(id); document.createElement = tag => new Element(tag);
  return { document, get: id => { assert.ok(elements.has(id), 'HTML element exists: ' + id); return elements.get(id); } };
}
function find(root, predicate) { if (predicate(root)) return root; for (const child of root.children) { const result = find(child, predicate); if (result) return result; } }
async function waitFor(check) { const deadline = Date.now() + 5000; while (!await check()) { if (Date.now() > deadline) throw new Error('Page state did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }

test('生成页面可取消和确认删除，失败可重试，迟到列表不复活已删任务，运行任务及空状态正确处理', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'generation-ui-test-'));
  let serial = 0, holdModel = false, modelStarted = false, modelAborted = false;
  const server = createAppServer({ configPath: path.join(directory, 'config.json'), generationExtract: async () => ({ ok: true, sha256: 'fixture-hash', units: [{ text: '验收模拟资料', location: '第 1 行' }] }), fetchImpl: async (_url, input) => {
    if (holdModel) {
      modelStarted = true;
      return new Promise((_resolve, reject) => { const stop = () => { modelAborted = true; reject(new Error('aborted')); }; if (input.signal.aborted) stop(); else input.signal.addEventListener('abort', stop, { once: true }); });
    }
    const number = ++serial;
    const record = { Question: '完整问题' + number, 'User Question': '用户问题' + number, 'SELECT Data': null, answer: '参考答案' + number, 'Scoring criteria': '回答准确得5分', difficulty: '易', 'Task family': '点查', source: 'SRC-0001' };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([record]) } }] }));
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const nativeFetch = globalThis.fetch, nativeTimer = globalThis.setTimeout, timers = [];
  const previous = Object.fromEntries(['document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    globalThis.fetch = nativeFetch; globalThis.setTimeout = nativeTimer; timers.forEach(clearTimeout);
    for (const [key, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
    await rm(directory, { recursive: true, force: true });
  });
  const api = async (route, method = 'GET', body) => (await nativeFetch(url + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })).json();
  const provider = (await api('/api/providers', 'POST', { name: '模拟模型', baseUrl: 'https://mock.example/v1', models: ['mock-model'], timeoutSeconds: 60 })).provider;
  const file = (await (await nativeFetch(url + '/api/files?name=sample.txt', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: '验收模拟资料' })).json()).file;
  const create = async name => (await api('/api/generations', 'POST', { name, fileIds: [file.id], providerId: provider.id, model: 'mock-model', count: 1, batchSize: 1 })).job;
  const first = await create('同名验收任务');
  await waitFor(async () => (await api('/api/generations/' + first.id)).job.status === 'completed');
  const second = await create('同名验收任务');
  await waitFor(async () => (await api('/api/generations/' + second.id)).job.status === 'completed');
  let failDelete = false, failReview = false, delayList = false, releaseList;
  globalThis.fetch = async (route, options) => {
    if (String(route).endsWith('/review') && failReview) { failReview = false; return new Response(JSON.stringify({ error: { message: '模拟送审失败，请重试。' } }), { status: 500 }); }
    if (options?.method === 'DELETE' && failDelete) { failDelete = false; return new Response(JSON.stringify({ error: { message: '模拟删除失败，请重试。' } }), { status: 500 }); }
    if (route === '/api/generations' && delayList) { delayList = false; const response = await nativeFetch(new URL(route, url), options); return new Promise(resolve => { releaseList = () => resolve(response); }); }
    return nativeFetch(new URL(route, url), options);
  };
  globalThis.setTimeout = (...args) => { const timer = nativeTimer(...args); timers.push(timer); return timer; };
  const { document, get } = documentFor(await readFile(new URL('../public/source-datasets.html', import.meta.url), 'utf8'));
  globalThis.document = document; globalThis.location = new URL(url + '/source-datasets');
  let reviewNavigation = null;
  globalThis.location.assign = target => { reviewNavigation = new URL(target, url); };
  await import('../public/source-datasets.js');
  await waitFor(() => get('generated-rows').children.length === 2);
  const sendReview = () => find(get('generated-rows').children.find(row => row.getAttribute('data-job-id') === first.id), element => element.tagName === 'BUTTON' && element.textContent === '送入审核');
  failReview = true; await sendReview().dispatch('click');
  assert.equal(reviewNavigation, null); assert.match(get('generated-notice').textContent, /模拟送审失败/);
  assert.ok(sendReview());
  await sendReview().dispatch('click');
  const sent = (await api('/api/generations/' + first.id)).job;
  assert.equal(reviewNavigation.pathname, '/expert-review');
  assert.equal(reviewNavigation.searchParams.get('dataset'), sent.reviewDatasetId);
  assert.equal(reviewNavigation.searchParams.get('configureFields'), '1');
  assert.equal((await api('/api/technical-reviews')).datasets.length, 1);
  assert.equal(sendReview(), undefined);
  const deleteButton = id => {
    const row = get('generated-rows').children.find(item => item.getAttribute('data-job-id') === id);
    assert.ok(row); return find(row, element => element.tagName === 'BUTTON' && element.textContent === '删除任务');
  };
  await deleteButton(second.id).dispatch('click');
  assert.equal(get('delete-task-dialog').open, true); assert.equal(get('delete-task-name').textContent, '同名验收任务.json'); assert.equal(get('delete-task-active').hidden, true);
  await get('delete-task-dialog').dispatch('cancel');
  assert.equal(get('delete-task-dialog').open, false); assert.equal(get('generated-rows').children.length, 2);
  await deleteButton(second.id).dispatch('click'); failDelete = true;
  await get('confirm-delete-task').dispatch('click');
  assert.equal(get('delete-task-error').hidden, false); assert.match(get('delete-task-error').textContent, /模拟删除失败/); assert.equal(get('delete-task-dialog').open, true); assert.equal(get('confirm-delete-task').disabled, false);
  delayList = true;
  const staleRefresh = get('refresh-generated').dispatch('click'); await waitFor(() => !!releaseList);
  await get('confirm-delete-task').dispatch('click');
  assert.equal(get('generated-rows').children.length, 1); assert.equal(get('delete-task-dialog').open, false);
  releaseList(); await staleRefresh;
  assert.equal(get('generated-rows').children.length, 1); assert.equal(get('generated-summary').textContent, '1 个 JSON 已完成 · 0 个任务进行中');
  assert.equal((await api('/api/generations')).jobs[0].id, first.id);
  holdModel = true; const running = await create('运行中验收任务'); await waitFor(() => modelStarted);
  await get('refresh-generated').dispatch('click'); await deleteButton(running.id).dispatch('click');
  assert.equal(get('delete-task-active').hidden, false);
  await get('confirm-delete-task').dispatch('click');
  assert.equal(modelAborted, true); assert.equal(get('generated-rows').children.length, 1);
  await deleteButton(first.id).dispatch('click'); await get('confirm-delete-task').dispatch('click');
  assert.equal(get('generated-rows').children.length, 0); assert.equal(get('generated-count').textContent, '0'); assert.equal(get('generated-empty').hidden, false); assert.match(get('generated-notice').textContent, /已删除任务/);
  assert.equal((await api('/api/files')).files[0].id, file.id);
});
