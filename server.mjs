import http from 'node:http';
import { readFile, mkdir, writeFile, rename, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createProviderApi } from './providers.mjs';
import { createFilesApi } from './files.mjs';
import { createPromptsApi } from './prompts.mjs';
import { createReviewsApi } from './reviews.mjs';
import { createGenerationsApi } from './generations.mjs';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(projectDir, 'public');
const defaults = { baseUrl: '', model: '', timeoutSeconds: 60 };
const BODY_LIMIT = 64 * 1024;
const RESPONSE_LIMIT = 1024 * 1024;

class RequestError extends Error {
  constructor(code, message, status = 400, detail = '') {
    super(message);
    Object.assign(this, { code, status, detail });
  }
}

function redact(value, secret = '') {
  let text = String(value ?? '');
  if (secret) {
    for (const candidate of new Set([secret, encodeURIComponent(secret)])) {
      text = text.split(candidate).join('[已隐藏]');
    }
  }
  return text
    .replace(/\bBearer\s+[^\s"'<>;,}]+/gi, 'Bearer [已隐藏]')
    .replace(/(\b(?:authorization|api[-_ ]?key)\b\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\r\n,;}]+)/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]');
}

function cleanResult(value, secret) {
  if (typeof value === 'string') return redact(value, secret);
  if (Array.isArray(value)) return value.map(item => cleanResult(item, secret));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanResult(item, secret)]));
  }
  return value;
}

function json(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(data));
}

function checkLocalRequest(req) {
  let host;
  try { host = new URL(`http://${req.headers.host}`); } catch {
    throw new RequestError('FORBIDDEN_HOST', '请从本机地址访问工具。', 403);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) ||
      Number(host.port || 80) !== req.socket.localPort || host.username || host.password) {
    throw new RequestError('FORBIDDEN_HOST', '请从本机地址访问工具。', 403);
  }
  if (req.headers.origin && req.headers.origin !== host.origin) {
    throw new RequestError('FORBIDDEN_ORIGIN', '已拒绝来自其他网站的访问，请在本工具页面操作。', 403);
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    throw new RequestError('FORBIDDEN_ORIGIN', '已拒绝来自其他网站的访问，请在本工具页面操作。', 403);
  }
}

async function readJson(req, limit = BODY_LIMIT) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new RequestError('UNSUPPORTED_CONTENT_TYPE', '请求需要使用 application/json 格式。', 415);
  }
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new RequestError('BODY_TOO_LARGE', '请求内容过大，请缩短输入。', 413);
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError('BODY_TOO_LARGE', '请求内容过大，请缩短输入。', 413);
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
    throw new RequestError('INVALID_JSON', '请求内容不是有效 JSON。');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('INVALID_INPUT', '请求内容需要是 JSON 对象。');
  }
  return body;
}

function normalizeConfig(input) {
  const baseUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const model = typeof input.model === 'string' ? input.model.trim() : '';
  const timeoutSeconds = Number(input.timeoutSeconds ?? 60);
  if (!baseUrl || baseUrl.length > 2048) {
    throw new RequestError('INVALID_URL', '请输入有效的模型 API 地址。');
  }
  let url;
  try { url = new URL(baseUrl); } catch {
    throw new RequestError('INVALID_URL', 'API 地址格式不正确，请包含 http:// 或 https://。');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash) {
    throw new RequestError('INVALID_URL', 'API 地址须为 HTTP(S) 地址，不能包含用户名、密码、查询参数或片段。');
  }
  if (!model || model.length > 256 || /[\r\n\u0000]/.test(model)) {
    throw new RequestError('INVALID_MODEL', '请输入模型名称（最长 256 个字符）。');
  }
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 180) {
    throw new RequestError('INVALID_TIMEOUT', '超时时间需要在 5–180 秒之间。');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), model, timeoutSeconds };
}

function makeEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, '');
  const base = prefix.replace(/\/models$/, '');
  url.pathname = prefix.endsWith('/chat/completions') ? prefix : `${base || '/v1'}/chat/completions`;
  return url.href;
}

async function readUpstream(response) {
  if (!response.body) return '';
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > RESPONSE_LIMIT) {
      throw new RequestError('RESPONSE_TOO_LARGE', '模型返回内容过大，无法完成连接测试。', 502);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function replyText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.filter(block => block && ['text', 'output_text'].includes(block.type))
      .map(block => typeof block.text === 'string' ? block.text : '').join('\n').trim();
  }
  return '';
}

function upstreamError(status) {
  if (status === 401) return ['AUTH_FAILED', '认证失败（401），请检查 API Key 是否正确、是否已过期。'];
  if (status === 403) return ['ACCESS_DENIED', '访问被拒绝（403），请检查账号、模型权限或服务访问限制。'];
  if (status === 404) return ['NOT_FOUND', '接口或模型不存在（404），请检查 API 地址和模型名称。'];
  if (status === 429) return ['RATE_LIMITED', '请求受限（429），请检查额度或稍后重试。'];
  if (status >= 500) return ['UPSTREAM_ERROR', `模型服务暂时异常（${status}），请稍后重试。`];
  return ['UPSTREAM_REJECTED', `模型服务拒绝了请求（${status}），请检查接口配置。`];
}

async function testConnection(input, fetchImpl) {
  const config = normalizeConfig(input);
  if (input.apiKey != null && typeof input.apiKey !== 'string') {
    throw new RequestError('INVALID_API_KEY', 'API Key 必须是字符串，或留空。');
  }
  const apiKey = (input.apiKey || '').trim();
  if (apiKey.length > 8192 || /[\r\n\u0000]/.test(apiKey)) {
    throw new RequestError('INVALID_API_KEY', 'API Key 格式不正确，请检查是否包含换行。');
  }
  const endpoint = makeEndpoint(config.baseUrl);
  const start = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);
  let httpStatus;
  try {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers, redirect: 'error', signal: controller.signal,
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: '请只回复：连接成功' }], stream: false }),
    });
    httpStatus = response.status;
    const raw = await readUpstream(response);
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      const [code, message] = upstreamError(httpStatus);
      const detail = typeof payload?.error?.message === 'string' ? payload.error.message :
        typeof payload?.message === 'string' ? payload.message : '上游未返回可解析的错误说明。';
      return { status: 502, data: cleanResult({ ok: false, error: { code, message, detail: redact(detail, apiKey).slice(0, 600) }, httpStatus, endpoint, latencyMs: Math.round(performance.now() - start) }, apiKey) };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RequestError('INVALID_RESPONSE', '接口已响应，但返回的不是有效的模型 JSON；请检查 API 地址是否指向聊天接口。', 502);
    }
    if (payload.error) {
      const detail = typeof payload.error.message === 'string' ? payload.error.message : '上游返回了错误对象。';
      throw new RequestError('UPSTREAM_ERROR', '模型服务返回错误，未得到模型回复。', 502, detail);
    }
    const reply = replyText(payload.choices?.[0]?.message?.content);
    if (!reply) {
      throw new RequestError('EMPTY_REPLY', '接口已响应，但没有收到实际模型文本回复；请检查模型是否支持 chat/completions。', 502);
    }
    const usage = payload.usage && typeof payload.usage === 'object' ? Object.fromEntries(
      ['prompt_tokens', 'completion_tokens', 'total_tokens'].filter(key => Number.isFinite(payload.usage[key])).map(key => [key, payload.usage[key]])
    ) : null;
    return { status: 200, data: cleanResult({ ok: true, reply, requestedModel: config.model, returnedModel: typeof payload.model === 'string' ? payload.model : null, latencyMs: Math.round(performance.now() - start), endpoint, httpStatus, usage, testedAt: new Date().toISOString() }, apiKey) };
  } catch (error) {
    const timeout = controller.signal.aborted || error.name === 'TimeoutError' || error.name === 'AbortError';
    const code = timeout ? 'TIMEOUT' : error.code && error instanceof RequestError ? error.code : 'NETWORK_ERROR';
    const message = timeout ? `连接超时（${config.timeoutSeconds} 秒），请检查地址、网络或增加超时时间。` :
      error instanceof RequestError ? error.message : '无法连接模型服务，请检查地址、端口、网络和证书。';
    const detail = timeout ? '' : error instanceof RequestError ? error.detail : '网络请求未成功完成（可能为连接拒绝、域名解析、证书或重定向问题）。';
    return { status: timeout ? 504 : 502, data: cleanResult({ ok: false, error: { code, message, detail: redact(detail, apiKey).slice(0, 600) }, ...(httpStatus ? { httpStatus } : {}), endpoint, latencyMs: Math.round(performance.now() - start) }, apiKey) };
  } finally {
    clearTimeout(timer);
  }
}

async function serveStatic(req, res) {
  let requestPath;
  try { requestPath = decodeURIComponent(req.url.split('?')[0]); } catch {
    throw new RequestError('BAD_PATH', '文件地址无效。', 400);
  }
  if (requestPath.includes('\\') || requestPath.includes('\u0000') || requestPath.split('/').includes('..')) {
    throw new RequestError('NOT_FOUND', '文件不存在。', 404);
  }
  const relative = requestPath === '/' ? 'index.html' : ['/files', '/files/'].includes(requestPath) ? 'files.html' : ['/source-datasets', '/source-datasets/'].includes(requestPath) ? 'source-datasets.html' : ['/prompts', '/prompts/'].includes(requestPath) ? 'prompts.html' : ['/technical-review', '/technical-review/'].includes(requestPath) ? 'technical-review.html' : ['/expert-review', '/expert-review/'].includes(requestPath) ? 'expert-review.html' : ['/frozen-datasets', '/frozen-datasets/'].includes(requestPath) ? 'frozen-datasets.html' : requestPath.replace(/^\/+/, '');
  const filename = path.resolve(publicDir, relative);
  const contained = candidate => candidate.startsWith(publicDir + path.sep);
  if (!contained(filename)) throw new RequestError('NOT_FOUND', '文件不存在。', 404);
  let file;
  try {
    const resolved = await realpath(filename);
    if (!contained(resolved) || !(await stat(resolved)).isFile()) throw new Error('outside');
    file = await readFile(resolved);
  } catch { throw new RequestError('NOT_FOUND', '文件不存在。', 404); }
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
  res.writeHead(200, {
    'Content-Type': types[path.extname(filename)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  res.end(req.method === 'HEAD' ? undefined : file);
}

export function createAppServer({ configPath = path.join(projectDir, 'data', 'config.json'), providersPath = path.join(path.dirname(configPath), 'providers.json'), promptsPath = path.join(path.dirname(configPath), 'prompts.json'), reviewsDirectory = path.join(path.dirname(configPath), 'technical-reviews'), filesDirectory = path.join(path.dirname(configPath), 'files'), generationsDirectory = path.join(path.dirname(configPath), 'generations'), generationExtract, filePreview, fetchImpl = globalThis.fetch, vault } = {}) {
  const providerApi = createProviderApi({ storePath: providersPath, legacyConfigPath: configPath, normalizeConfig, testConnection, fetchImpl, readJson, json, RequestError, vault });
  const filesApi = createFilesApi({ directory: filesDirectory, readJson, json, RequestError, preview: filePreview });
  const promptsApi = createPromptsApi({ storePath: promptsPath, readJson: req => readJson(req, 256 * 1024), json, RequestError });
  const reviewsApi = createReviewsApi({ directory: reviewsDirectory, readJson: req => readJson(req, 20 * 1024 * 1024), json, RequestError });
  const generationsApi = createGenerationsApi({ directory: generationsDirectory, getConnection: providerApi.resolveConnection, getSource: filesApi.resolveFile, importDataset: reviewsApi.importDataset, getActiveReviewDatasetIds: reviewsApi.activeDatasetIds, makeEndpoint, fetchImpl, redact, readJson: req => readJson(req, 512 * 1024), json, RequestError, extract: generationExtract });
  const app = http.createServer(async (req, res) => {
    try {
      checkLocalRequest(req);
      const pathname = req.url.split('?')[0];
      if (pathname === '/api/health' && req.method === 'GET') return json(res, 200, { ok: true, app: 'eval-dataset-workspace', version: '0.9.0' });
      if (await generationsApi(req, res, new URL(req.url, 'http://localhost'))) return;
      if (await reviewsApi(req, res, new URL(req.url, 'http://localhost'))) return;
      if (await promptsApi(req, res, pathname)) return;
      if (await filesApi(req, res, new URL(req.url, 'http://localhost'))) return;
      if (await providerApi(req, res, pathname)) return;
      if (pathname === '/api/config' && req.method === 'GET') {
        let config = defaults;
        try { config = normalizeConfig(JSON.parse(await readFile(configPath, 'utf8'))); } catch (error) {
          if (error.code !== 'ENOENT' && !(error instanceof RequestError) && !(error instanceof SyntaxError)) throw error;
        }
        return json(res, 200, config);
      }
      if (pathname === '/api/config' && req.method === 'POST') {
        const config = normalizeConfig(await readJson(req));
        await mkdir(path.dirname(configPath), { recursive: true });
        const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
        await writeFile(temporaryPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
        await rename(temporaryPath, configPath);
        return json(res, 200, { ok: true, ...config });
      }
      if (pathname === '/api/test-connection' && req.method === 'POST') {
        const result = await testConnection(await readJson(req), fetchImpl);
        return json(res, result.status, result.data);
      }
      if (pathname.startsWith('/api/')) return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '接口不存在或请求方法不正确。', detail: '' } });
      if (!['GET', 'HEAD'].includes(req.method)) throw new RequestError('METHOD_NOT_ALLOWED', '请求方法不支持。', 405);
      await serveStatic(req, res);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error instanceof RequestError ? error.status : 500, { ok: false, error: { code: error instanceof RequestError ? error.code : 'INTERNAL_ERROR', message: error instanceof RequestError ? error.message : '本地服务处理失败，请重试并检查配置目录权限。', detail: '' } });
    }
  });
  app.on('close', generationsApi.dispose);
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('PORT 必须是 1–65535 之间的端口号。');
    process.exitCode = 1;
  } else {
    const server = createAppServer();
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请关闭旧服务或设置其他 PORT。` : '本地服务启动失败，请检查端口权限。');
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => console.log(`评测集构建工具：http://127.0.0.1:${port}`));
  }
}
