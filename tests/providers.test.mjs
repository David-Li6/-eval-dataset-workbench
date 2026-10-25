import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';
import { windowsVault } from '../providers.mjs';

// Fast injectable vault for persistence logic; actual Windows DPAPI tested separately.
const vault = { encrypt: async value => 'test-sealed:' + Buffer.from(value).toString('base64'), decrypt: async value => Buffer.from(value.slice(12), 'base64').toString() };
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return 'http://127.0.0.1:' + server.address().port;
}
async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'providers-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  const providersPath = path.join(dir, 'providers.json');
  const calls = [];
  const upstream = await listen(t, http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ url: req.url, auth: req.headers.authorization, model: body.model });
    if (body.model === 'fail') {
      res.writeHead(401);
      return res.end(JSON.stringify({ error: { message: req.headers.authorization || 'missing key' } }));
    }
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: '连接成功' } }] }));
  }));
  const create = () => createAppServer({ configPath, providersPath, vault, ...options });
  const appUrl = await listen(t, create());
  const call = async (route, method = 'GET', body, origin) => {
    const response = await fetch((origin || appUrl) + route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const input = { name: '本地供应商', baseUrl: upstream + '/v1', models: ['model-a', 'model-b'], timeoutSeconds: 5, apiKey: 'provider-test-key-123' };
  return { dir, configPath, providersPath, create, appUrl, calls, call, input, upstream };
}

test('多供应商保存、去重、重启恢复，接口不返回任何密钥字段', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/providers')).data, { providers: [] });
  const first = await f.call('/api/providers', 'POST', { ...f.input, models: ['model-a', ' model-b ', 'model-a'] });
  assert.equal(first.status, 201);
  assert.equal(first.data.provider.hasApiKey, true);
  assert.deepEqual(first.data.provider.models, ['model-a', 'model-b']);
  assert.equal(first.data.provider.lastTest, null);
  assert.equal(first.data.provider.revision, 1);
  await f.call('/api/providers', 'POST', { ...f.input, name: '第二个', apiKey: '' });
  const restarted = await listen(t, f.create());
  const list = await f.call('/api/providers', 'GET', undefined, restarted);
  assert.equal(list.data.providers.length, 2);
  assert.equal(list.data.providers[1].hasApiKey, false);
  assert.ok(!JSON.stringify(list).includes('encryptedApiKey'));
  assert.ok(!JSON.stringify(list).includes(f.input.apiKey));
  assert.ok(!(await readFile(f.providersPath, 'utf8')).includes(f.input.apiKey));
  assert.equal(f.calls.length, 0);
});

test('旧版配置只迁移一次，删除后不会重新出现', async t => {
  const f = await fixture(t);
  const legacy = { baseUrl: f.input.baseUrl, model: 'legacy-model', timeoutSeconds: 60 };
  await writeFile(f.configPath, JSON.stringify(legacy));
  const list = (await f.call('/api/providers')).data.providers;
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'legacy-model');
  assert.deepEqual(list[0].models, ['legacy-model']);
  await f.call('/api/providers/' + list[0].id, 'DELETE', { revision: list[0].revision });
  const restarted = await listen(t, f.create());
  assert.deepEqual((await f.call('/api/providers', 'GET', undefined, restarted)).data.providers, []);
  assert.deepEqual(JSON.parse(await readFile(f.configPath, 'utf8')), legacy);
});

test('测试草稿后保存，真实测试结果随供应商保存；更改地址后失效', async t => {
  const f = await fixture(t);
  const trial = await f.call('/api/providers/test', 'POST', { ...f.input, model: 'model-b' });
  assert.equal(trial.data.ok, true);
  assert.equal(f.calls[0].auth, 'Bearer ' + f.input.apiKey);
  assert.equal(f.calls[0].model, 'model-b');
  const save = await f.call('/api/providers', 'POST', { ...f.input, testReceipt: trial.data.testReceipt });
  let provider = save.data.provider;
  assert.equal(provider.lastTest.ok, true);
  assert.equal(provider.lastTest.model, 'model-b');
  provider = (await f.call('/api/providers/' + provider.id, 'PUT', { ...f.input, apiKey: '', name: '改名', revision: provider.revision })).data.provider;
  assert.equal(provider.lastTest.ok, true);
  provider = (await f.call('/api/providers/' + provider.id, 'PUT', { ...f.input, apiKey: '', name: '改名', baseUrl: f.upstream + '/different/v1', revision: provider.revision })).data.provider;
  assert.equal(provider.lastTest, null);
  assert.equal(provider.hasApiKey, true);
});

test('编辑时保留、替换、清除密钥；使用保存的密钥测试，重启也可复用', async t => {
  const f = await fixture(t);
  let p = (await f.call('/api/providers', 'POST', f.input)).data.provider;
  const restarted = await listen(t, f.create());
  let trial = await f.call('/api/providers/test', 'POST', { id: p.id, baseUrl: p.baseUrl, model: 'model-a', timeoutSeconds: 5 }, restarted);
  assert.equal(trial.data.ok, true);
  assert.equal(f.calls.at(-1).auth, 'Bearer ' + f.input.apiKey);
  p = (await f.call('/api/providers/' + p.id, 'PUT', { ...f.input, revision: p.revision, apiKey: 'replacement-key' })).data.provider;
  await f.call('/api/providers/test', 'POST', { id: p.id, baseUrl: p.baseUrl, model: 'model-a', timeoutSeconds: 5 });
  assert.equal(f.calls.at(-1).auth, 'Bearer replacement-key');
  p = (await f.call('/api/providers/' + p.id, 'PUT', { ...f.input, revision: p.revision, apiKey: '', clearApiKey: true })).data.provider;
  assert.equal(p.hasApiKey, false);
  await f.call('/api/providers/test', 'POST', { id: p.id, baseUrl: p.baseUrl, model: 'model-a', timeoutSeconds: 5 });
  assert.equal(f.calls.at(-1).auth, undefined);
});

test('失败测试可保存，错误信息已脱敏；伪造和错配的测试结果不生效', async t => {
  const f = await fixture(t);
  const trial = await f.call('/api/providers/test', 'POST', { ...f.input, model: 'fail' });
  assert.equal(trial.data.ok, false);
  assert.ok(!JSON.stringify(trial).includes(f.input.apiKey));
  const saved = await f.call('/api/providers', 'POST', { ...f.input, models: ['fail'], testReceipt: trial.data.testReceipt });
  assert.equal(saved.data.provider.lastTest.ok, false);
  const fake = await f.call('/api/providers', 'POST', { ...f.input, name: '伪造测试', testReceipt: 'fake', lastTest: { ok: true } });
  assert.equal(fake.data.provider.lastTest, null);
  const good = await f.call('/api/providers/test', 'POST', { ...f.input, model: 'model-a' });
  const mismatch = await f.call('/api/providers', 'POST', { ...f.input, name: '变更凭证', apiKey: 'new-key', testReceipt: good.data.testReceipt });
  assert.equal(mismatch.data.provider.lastTest, null);
});

test('并发添加不会丢失，旧版本编辑或删除不会覆盖新版本', async t => {
  const f = await fixture(t);
  const results = await Promise.all([0, 1, 2, 3].map(i => f.call('/api/providers', 'POST', { ...f.input, name: 'provider-' + i })));
  assert.equal((await f.call('/api/providers')).data.providers.length, 4);
  const p = results[0].data.provider;
  const body = { ...f.input, name: p.name, revision: p.revision, apiKey: '' };
  assert.equal((await f.call('/api/providers/' + p.id, 'PUT', body)).status, 200);
  assert.equal((await f.call('/api/providers/' + p.id, 'PUT', body)).status, 409);
  assert.equal((await f.call('/api/providers/' + p.id, 'DELETE', { revision: p.revision })).status, 409);
});

test('删除后列表与测试不可用，保存文件保留可恢复记录', async t => {
  const f = await fixture(t);
  const p = (await f.call('/api/providers', 'POST', f.input)).data.provider;
  assert.equal((await f.call('/api/providers/' + p.id, 'DELETE', { revision: p.revision })).status, 200);
  assert.equal((await f.call('/api/providers')).data.providers.length, 0);
  assert.equal((await f.call('/api/providers/test', 'POST', { ...f.input, model: 'model-a', id: p.id })).status, 404);
  assert.ok(JSON.parse(await readFile(f.providersPath, 'utf8')).providers[0].deletedAt);
});

test('拒绝无效名称、模型列表、重复供应商和密钥输入', async t => {
  const f = await fixture(t);
  for (const change of [{ name: '' }, { models: [] }, { models: [''] }, { models: [123] }, { models: ['x'.repeat(257)] }, { apiKey: 42 }, { apiKey: 'new', clearApiKey: true }, { clearApiKey: 'true' }]) {
    assert.equal((await f.call('/api/providers', 'POST', { ...f.input, ...change })).status, 400);
  }
  await f.call('/api/providers', 'POST', f.input);
  assert.equal((await f.call('/api/providers', 'POST', f.input)).status, 409);
});

test('损坏配置与加密失败不覆盖或保存错误数据', async t => {
  const f = await fixture(t, { vault: { encrypt: async () => { throw new Error('secret must not echo'); } } });
  assert.equal((await f.call('/api/providers', 'POST', f.input)).status, 500);
  assert.equal((await f.call('/api/providers')).data.providers.length, 0);
  await writeFile(f.providersPath, 'corrupt-original-content');
  assert.equal((await f.call('/api/providers', 'POST', { ...f.input, apiKey: '' })).status, 500);
  assert.equal(await readFile(f.providersPath, 'utf8'), 'corrupt-original-content');
});

test('真实 Windows DPAPI 加密、保存、重启后解密调用', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { vault: windowsVault });
  const p = (await f.call('/api/providers', 'POST', f.input)).data.provider;
  assert.equal(p.hasApiKey, true);
  const stored = await readFile(f.providersPath, 'utf8');
  assert.ok(!stored.includes(f.input.apiKey));
  const ciphertext = JSON.parse(stored).providers[0].encryptedApiKey;
  assert.notEqual(ciphertext, Buffer.from(f.input.apiKey).toString('base64'));
  const restarted = await listen(t, f.create());
  const result = await f.call('/api/providers/test', 'POST', { id: p.id, baseUrl: p.baseUrl, model: 'model-a', timeoutSeconds: 5 }, restarted);
  assert.equal(result.data.ok, true);
  assert.equal(f.calls.at(-1).auth, 'Bearer ' + f.input.apiKey);
});
