import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

async function start(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eval-tool-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = path.join(directory, 'config.json');
  const observed = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    observed.push({ url: req.url, headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') });
    if (handler) return handler(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'mock-model-v1', choices: [{ message: { content: '连接成功' } }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }));
  });
  const baseUrl = await start(t, upstream);
  const appUrl = await start(t, createAppServer({ configPath, ...options }));
  const post = async (pathname, body = {}, headers = {}) => {
    const response = await fetch(appUrl + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const input = { baseUrl, model: 'mock-model', timeoutSeconds: 5, apiKey: 'test-private-key-123456' };
  return { baseUrl, appUrl, configPath, observed, post, input };
}

test('健康检查与默认配置可用，配置保存不向模型发送请求且不保存密钥', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(f.appUrl + '/api/health')).json(), { ok: true, app: 'eval-dataset-workspace', version: '0.9.0' });
  assert.deepEqual(await (await fetch(f.appUrl + '/api/config')).json(), { baseUrl: '', model: '', timeoutSeconds: 60 });
  const saved = await f.post('/api/config', { ...f.input, extra: 'discard' });
  assert.equal(saved.status, 200);
  const storedText = await readFile(f.configPath, 'utf8');
  assert.ok(!storedText.includes(f.input.apiKey));
  const expected = { baseUrl: f.baseUrl, model: 'mock-model', timeoutSeconds: 5 };
  assert.deepEqual(JSON.parse(storedText), expected);
  assert.deepEqual(await (await fetch(f.appUrl + '/api/config')).json(), expected);
  assert.equal(f.observed.length, 0);
});

test('连接测试真实调用模型并返回回复、耗时、模型与 usage', async t => {
  const f = await fixture(t);
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.status, 200);
  assert.equal(result.data.ok, true);
  assert.equal(result.data.reply, '连接成功');
  assert.equal(result.data.requestedModel, 'mock-model');
  assert.equal(result.data.returnedModel, 'mock-model-v1');
  assert.equal(result.data.httpStatus, 200);
  assert.equal(result.data.endpoint, f.baseUrl + '/v1/chat/completions');
  assert.ok(result.data.latencyMs >= 0);
  assert.ok(Number.isFinite(Date.parse(result.data.testedAt)));
  assert.deepEqual(result.data.usage, { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  assert.equal(f.observed[0].headers.authorization, `Bearer ${f.input.apiKey}`);
  assert.deepEqual(f.observed[0].body, { model: 'mock-model', messages: [{ role: 'user', content: '请只回复：连接成功' }], stream: false });
  assert.ok(!JSON.stringify(result.data).includes(f.input.apiKey));
  await assert.rejects(readFile(f.configPath), { code: 'ENOENT' });
});

test('根地址、版本前缀、网关前缀、完整接口地址和结尾斜杠均正确归一', async t => {
  const f = await fixture(t);
  const cases = [
    ['', '/v1/chat/completions'], ['/', '/v1/chat/completions'],
    ['/v1', '/v1/chat/completions'], ['/v1/', '/v1/chat/completions'],
    ['/gateway/api/v1', '/gateway/api/v1/chat/completions'],
    ['/v1/models', '/v1/chat/completions'], ['/gateway/api/v1/models/', '/gateway/api/v1/chat/completions'],
    ['/chat/completions', '/chat/completions'], ['/v1/chat/completions/', '/v1/chat/completions'],
  ];
  for (const [suffix, endpoint] of cases) {
    const result = await f.post('/api/test-connection', { ...f.input, baseUrl: f.baseUrl + suffix });
    assert.equal(result.status, 200);
    assert.equal(f.observed.at(-1).url, endpoint);
  }
});

test('本地无密钥模型不发送 Authorization', async t => {
  const f = await fixture(t);
  const result = await f.post('/api/test-connection', { ...f.input, apiKey: '' });
  assert.equal(result.status, 200);
  assert.equal(f.observed[0].headers.authorization, undefined);
});

test('支持文本块数组，忽略非文本块', async t => {
  const f = await fixture(t, (_req, res) => res.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: '连接' }, { type: 'image', url: 'unused' }, { type: 'output_text', text: '成功' }] } }] })));
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.data.reply, '连接\n成功');
  assert.equal(result.data.returnedModel, null);
  assert.equal(result.data.usage, null);
});

for (const [upstreamStatus, code] of [[401, 'AUTH_FAILED'], [403, 'ACCESS_DENIED'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED'], [503, 'UPSTREAM_ERROR']]) {
  test(`上游 ${upstreamStatus} 返回中文原因和原始状态`, async t => {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(upstreamStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'upstream failure' } }));
    });
    const result = await f.post('/api/test-connection', f.input);
    assert.equal(result.status, 502);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error.code, code);
    assert.equal(result.data.httpStatus, upstreamStatus);
    assert.match(result.data.error.message, /[\u4e00-\u9fff]/);
  });
}

for (const [body, code] of [
  ['{}', 'EMPTY_REPLY'],
  ['{"choices":[{"message":{"content":"   "}}]}', 'EMPTY_REPLY'],
  ['{"choices":[{"message":{"content":null,"reasoning_content":"thinking"}}]}', 'EMPTY_REPLY'],
  ['<html>Login</html>', 'INVALID_RESPONSE'],
  ['null', 'INVALID_RESPONSE'],
  ['{"error":{"message":"failure"}}', 'UPSTREAM_ERROR'],
]) {
  test(`200 异常或空响应不算连接成功：${body.slice(0, 35)}`, async t => {
    const f = await fixture(t, (_req, res) => res.end(body));
    const result = await f.post('/api/test-connection', f.input);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error.code, code);
    assert.equal(result.data.httpStatus, 200);
  });
}

test('错误、成功内容和 Authorization 回显中的密钥均被隐藏', async t => {
  const secret = 'test-private-key-123456';
  for (const status of [200, 401]) {
    const f = await fixture(t, (_req, res) => {
      res.writeHead(status);
      const content = `${secret}; Authorization: Bearer another-secret; api_key="another-secret"`;
      res.end(JSON.stringify(status === 200 ? { model: secret, choices: [{ message: { content } }] } : { error: { message: content } }));
    });
    const result = await f.post('/api/test-connection', f.input);
    const serialized = JSON.stringify(result.data);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes('another-secret'));
    assert.ok(serialized.includes('[已隐藏]'));
  }
});

test('网络异常不回传原始异常中的密钥', async t => {
  const f = await fixture(t, null, { fetchImpl: async () => { throw new Error('network error test-private-key-123456 Authorization: Bearer secret'); } });
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.data.error.code, 'NETWORK_ERROR');
  assert.ok(!JSON.stringify(result.data).includes(f.input.apiKey));
});

test('实际超时取消模型请求并返回 TIMEOUT', async t => {
  const f = await fixture(t, () => {});
  const started = Date.now();
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.status, 504);
  assert.equal(result.data.error.code, 'TIMEOUT');
  assert.ok(Date.now() - started >= 4800);
  assert.ok(Date.now() - started < 9000);
});

test('拒绝重定向，不将密钥发送到重定向地址', async t => {
  let redirected = 0;
  const destination = await start(t, http.createServer((_req, res) => { redirected += 1; res.end('{}'); }));
  const f = await fixture(t, (_req, res) => { res.writeHead(307, { Location: destination }); res.end(); });
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.data.error.code, 'NETWORK_ERROR');
  assert.equal(redirected, 0);
});

test('输入校验覆盖协议、凭证 URL、查询参数、模型、超时和密钥', async t => {
  const f = await fixture(t);
  const cases = [
    [{ baseUrl: '' }, 'INVALID_URL'], [{ baseUrl: 'not-a-url' }, 'INVALID_URL'],
    [{ baseUrl: 'file:///tmp/model' }, 'INVALID_URL'], [{ baseUrl: 'http://user:pass@localhost:8000' }, 'INVALID_URL'],
    [{ baseUrl: 'https://example.test/v1?api_key=secret' }, 'INVALID_URL'],
    [{ baseUrl: 'https://example.test/#fragment' }, 'INVALID_URL'],
    [{ model: '' }, 'INVALID_MODEL'], [{ timeoutSeconds: 4 }, 'INVALID_TIMEOUT'],
    [{ timeoutSeconds: 181 }, 'INVALID_TIMEOUT'], [{ timeoutSeconds: 'nope' }, 'INVALID_TIMEOUT'],
    [{ apiKey: 123 }, 'INVALID_API_KEY'], [{ apiKey: 'bad\nkey' }, 'INVALID_API_KEY'],
  ];
  for (const [change, code] of cases) {
    const result = await f.post('/api/test-connection', { ...f.input, ...change });
    assert.equal(result.status, 400);
    assert.equal(result.data.error.code, code);
  }
  assert.equal(f.observed.length, 0);
});

test('只接受 JSON 对象，拒绝错误 JSON 和超大请求', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/test-connection', f.input, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post('/api/test-connection', [])).status, 400);
  assert.equal((await f.post('/api/test-connection', { ...f.input, padding: 'a'.repeat(70 * 1024) })).status, 413);
  const bad = await fetch(f.appUrl + '/api/test-connection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(bad.status, 400);
  assert.equal(f.observed.length, 0);
});

test('拒绝跨站 Origin 和跨站 Fetch Metadata，允许同源及本机脚本', async t => {
  const f = await fixture(t);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const rejected = await f.post('/api/test-connection', f.input, headers);
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get('access-control-allow-origin'), null);
  }
  assert.equal((await f.post('/api/test-connection', f.input, { Origin: f.appUrl })).status, 200);
  assert.equal(f.observed.length, 1);
  const rebinding = await rawGet(f.appUrl, '/api/config', { Host: 'evil.example' });
  assert.equal(rebinding.status, 403);
});

function rawGet(baseUrl, requestPath, headers = {}) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    http.get({ hostname: url.hostname, port: url.port, path: requestPath, headers }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    }).on('error', reject);
  });
}

test('静态文件不能穿越目录或读取服务源码、配置', async t => {
  const f = await fixture(t);
  await f.post('/api/config', f.input);
  for (const requested of ['/server.mjs', '/data/config.json', '/../server.mjs', '/%2e%2e/server.mjs', '/..%5cserver.mjs', '/%00', '/C:/Windows/win.ini']) {
    const result = await rawGet(f.appUrl, requested);
    assert.equal(result.status, 404, requested);
    assert.ok(!result.body.includes('createAppServer'));
  }
});

test('超大模型响应作为错误处理', async t => {
  const f = await fixture(t, (_req, res) => res.end('x'.repeat(1024 * 1024 + 1)));
  const result = await f.post('/api/test-connection', f.input);
  assert.equal(result.data.error.code, 'RESPONSE_TOO_LARGE');
});
