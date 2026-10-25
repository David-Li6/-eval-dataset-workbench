import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';

// Windows DPAPI ties encrypted credentials to the current Windows account.
// Secrets travel over stdin, never command-line arguments or logs.
async function dpapi(value, decrypt = false) {
  if (!value) return '';
  if (process.platform !== 'win32') throw new Error('Windows credential protection is required');
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); ` +
    (decrypt
      ? '$b=[Convert]::FromBase64String($s); $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))'
      : '$b=[Convert]::FromBase64String($s); $p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))');
  const output = await new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(new Error('Credential protection failed')) : resolve(stdout.trim()));
    child.stdin.on('error', () => {});
    child.stdin.end(decrypt ? value : Buffer.from(value, 'utf8').toString('base64'));
  });
  return decrypt ? Buffer.from(output, 'base64').toString('utf8') : output;
}

export const windowsVault = { encrypt: value => dpapi(value), decrypt: value => dpapi(value, true) };

export function createProviderApi({ storePath, legacyConfigPath, normalizeConfig, testConnection, fetchImpl, readJson, json, RequestError, vault = windowsVault }) {
  let queue = Promise.resolve();
  const receipts = new Map();
  const serialized = action => {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  };
  async function writeStore(store) {
    await mkdir(path.dirname(storePath), { recursive: true });
    const temp = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    await rename(temp, storePath);
  }
  async function readStore() {
    try {
      const store = JSON.parse(await readFile(storePath, 'utf8'));
      if (store.version !== 1 || !Array.isArray(store.providers)) throw new Error('Invalid store');
      return store;
    } catch (error) {
      if (error.code !== 'ENOENT') throw new RequestError('STORE_ERROR', '供应商配置文件无法读取，请检查文件，原数据未被覆盖。', 500);
      const store = { version: 1, providers: [] };
      try {
        const config = normalizeConfig(JSON.parse(await readFile(legacyConfigPath, 'utf8')));
        const now = new Date().toISOString();
        store.providers.push({ id: randomUUID(), name: config.model, baseUrl: config.baseUrl, models: [config.model], timeoutSeconds: config.timeoutSeconds, encryptedApiKey: '', revision: 1, createdAt: now, updatedAt: now, lastTest: null });
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError) && !(error instanceof RequestError)) throw error;
      }
      await writeStore(store);
      return store;
    }
  }
  function publicProvider(provider) {
    const { encryptedApiKey, deletedAt, ...safe } = provider;
    return { ...safe, hasApiKey: !!encryptedApiKey };
  }
  function lookup(store, id) {
    const provider = store.providers.find(item => item.id === id && !item.deletedAt);
    if (!provider) throw new RequestError('PROVIDER_NOT_FOUND', '供应商不存在或已删除，请刷新列表。', 404);
    return provider;
  }
  function validateProvider(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new RequestError('INVALID_NAME', '请输入供应商名称，最长 80 个字符。');
    if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > 100) throw new RequestError('INVALID_MODELS', '请配置 1–100 个模型名称，每行一个。');
    if (body.models.some(model => typeof model !== 'string')) throw new RequestError('INVALID_MODELS', '模型名称必须为文字。');
    const models = [...new Set(body.models.map(model => model.trim()))];
    const config = normalizeConfig({ ...body, model: models[0] });
    for (const model of models) normalizeConfig({ ...config, model });
    validateKey(body);
    return { name, baseUrl: config.baseUrl, models, timeoutSeconds: config.timeoutSeconds };
  }
  function validateKey(body) {
    if (body.clearApiKey != null && typeof body.clearApiKey !== 'boolean') throw new RequestError('INVALID_API_KEY', '清除密钥选项必须为布尔值。');
    if (body.apiKey != null && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\r\n\u0000]/.test(body.apiKey))) throw new RequestError('INVALID_API_KEY', 'API Key 格式不正确。');
    if (body.clearApiKey && body.apiKey?.trim()) throw new RequestError('INVALID_API_KEY', '更换密钥与清除密钥不能同时选择。');
  }
  async function keyFor(body, existing) {
    validateKey(body);
    if (body.clearApiKey) return '';
    if (body.apiKey?.trim()) return body.apiKey.trim();
    if (!existing?.encryptedApiKey) return '';
    try { return await vault.decrypt(existing.encryptedApiKey); }
    catch { throw new RequestError('KEY_UNAVAILABLE', '无法读取已保存的密钥，请在当前 Windows 账户下使用，或重新填写 API Key。', 500); }
  }
  const fingerprint = config => createHash('sha256').update(JSON.stringify([config.baseUrl, config.model, config.timeoutSeconds, config.apiKey])).digest('hex');
  function validRevision(body, existing) {
    if (body.revision !== existing.revision) throw new RequestError('CONFLICT', '该供应商已在其他窗口更新，请关闭设置、刷新列表后再修改。', 409);
  }
  async function save(body, id) {
    const config = validateProvider(body);
    return serialized(async () => {
      const store = await readStore();
      const existing = id ? lookup(store, id) : null;
      if (existing) validRevision(body, existing);
      if (store.providers.some(item => !item.deletedAt && item.id !== id && item.name.toLowerCase() === config.name.toLowerCase())) throw new RequestError('DUPLICATE_NAME', '供应商名称已存在，请使用其他名称。', 409);
      let encryptedApiKey = existing?.encryptedApiKey || '';
      if (body.clearApiKey) encryptedApiKey = '';
      else if (body.apiKey?.trim()) {
        try { encryptedApiKey = await vault.encrypt(body.apiKey.trim()); }
        catch { throw new RequestError('KEY_SAVE_FAILED', '密钥加密保存失败，供应商未保存。请检查 Windows 账户权限后重试。', 500); }
      }
      const sameConnection = existing && existing.baseUrl === config.baseUrl && existing.timeoutSeconds === config.timeoutSeconds && existing.encryptedApiKey === encryptedApiKey;
      let lastTest = sameConnection && config.models.includes(existing.lastTest?.model) ? existing.lastTest : null;
      const receipt = receipts.get(body.testReceipt);
      if (receipt && receipt.expires > Date.now() && receipt.providerId === (id || null) && config.models.includes(receipt.summary.model)) {
        const apiKey = await keyFor(body, existing);
        if (receipt.fingerprint === fingerprint({ ...config, model: receipt.summary.model, apiKey })) lastTest = receipt.summary;
      }
      const now = new Date().toISOString();
      const provider = { id: id || randomUUID(), ...config, encryptedApiKey, revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now, lastTest };
      if (existing) store.providers[store.providers.indexOf(existing)] = provider;
      else store.providers.push(provider);
      await writeStore(store);
      if (receipt) receipts.delete(body.testReceipt);
      return publicProvider(provider);
    });
  }
  const api = async (req, res, pathname) => {
    if (!pathname.startsWith('/api/providers')) return false;
    if (pathname === '/api/providers' && req.method === 'GET') {
      const store = await serialized(readStore);
      json(res, 200, { providers: store.providers.filter(item => !item.deletedAt).map(publicProvider) });
      return true;
    }
    if (pathname === '/api/providers' && req.method === 'POST') {
      json(res, 201, { ok: true, provider: await save(await readJson(req)) });
      return true;
    }
    if (pathname === '/api/providers/test' && req.method === 'POST') {
      const body = await readJson(req);
      const config = normalizeConfig(body);
      const existing = body.id ? await serialized(async () => lookup(await readStore(), body.id)) : null;
      const apiKey = await keyFor(body, existing);
      const result = await testConnection({ ...config, apiKey }, fetchImpl);
      const testReceipt = randomUUID();
      for (const [token, receipt] of receipts) if (receipt.expires < Date.now()) receipts.delete(token);
      if (receipts.size >= 500) receipts.delete(receipts.keys().next().value);
      const testedAt = result.data.testedAt || new Date().toISOString();
      receipts.set(testReceipt, { providerId: existing?.id || null, expires: Date.now() + 30 * 60 * 1000, fingerprint: fingerprint({ ...config, apiKey }), summary: { ok: result.data.ok, model: config.model, latencyMs: result.data.latencyMs, httpStatus: result.data.httpStatus || null, message: result.data.ok ? '模型已返回有效回复' : result.data.error.message, testedAt } });
      json(res, result.status, { ...result.data, testedAt, testReceipt });
      return true;
    }
    const match = pathname.match(/^\/api\/providers\/([a-f0-9-]+)$/);
    if (match && req.method === 'PUT') {
      json(res, 200, { ok: true, provider: await save(await readJson(req), match[1]) });
      return true;
    }
    if (match && req.method === 'DELETE') {
      const body = await readJson(req);
      await serialized(async () => {
        const store = await readStore();
        const provider = lookup(store, match[1]);
        validRevision(body, provider);
        provider.deletedAt = new Date().toISOString();
        provider.revision += 1;
        await writeStore(store);
      });
      json(res, 200, { ok: true });
      return true;
    }
    throw new RequestError('NOT_FOUND', '供应商接口不存在或请求方法不正确。', 404);
  };
  api.resolveConnection = async (id, model, revision) => {
    const provider = await serialized(async () => lookup(await readStore(), id));
    if (revision != null && revision !== provider.revision) throw new RequestError('PROVIDER_CHANGED', '模型配置已更新，请重新创建生成任务以使用新配置。', 409);
    if (!provider.models.includes(model)) throw new RequestError('INVALID_MODEL', '所选模型不在此配置中，请重新选择。');
    return { id: provider.id, name: provider.name, baseUrl: provider.baseUrl, model, revision: provider.revision, apiKey: await keyFor({}, provider) };
  };
  return api;
}
