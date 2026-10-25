import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractVariables } from './public/prompt-utils.js';

export function createPromptsApi({ storePath, readJson, json, RequestError }) {
  let queue = Promise.resolve();
  function serialize(action) {
    const task = queue.then(action);
    queue = task.catch(() => {});
    return task;
  }
  async function readStore() {
    try {
      const store = JSON.parse(await readFile(storePath, 'utf8'));
      if (store.version !== 1 || !Array.isArray(store.templates)) throw new Error();
      return store;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, templates: [] };
      throw new RequestError('PROMPTS_STORE_ERROR', '提示词库无法读取，请检查本机配置文件，已有模板未被覆盖。', 500);
    }
  }
  async function writeStore(store) {
    await mkdir(path.dirname(storePath), { recursive: true });
    const tempPath = storePath + '.' + randomUUID() + '.tmp';
    await writeFile(tempPath, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
    await rename(tempPath, storePath);
  }
  function validate(body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const category = typeof body.category === 'string' ? body.category.trim() : '';
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!name || name.length > 100 || /[\u0000-\u001f]/.test(name)) throw new RequestError('INVALID_TEMPLATE_NAME', '请填写模板名称，最多 100 个字符。');
    if (category.length > 40 || /[\u0000-\u001f]/.test(category)) throw new RequestError('INVALID_TEMPLATE_CATEGORY', '分类最多 40 个字符，且不能包含换行。');
    if (description.length > 300) throw new RequestError('INVALID_TEMPLATE_DESCRIPTION', '用途说明最多 300 个字符。');
    if (!content.trim() || content.length > 50000 || content.includes('\u0000')) throw new RequestError('INVALID_TEMPLATE_CONTENT', '请填写提示词正文，最多 50,000 个字符。');
    if (extractVariables(content).length > 100) throw new RequestError('TOO_MANY_VARIABLES', '一个模板最多配置 100 个不同的变量。');
    return { name, category: category || '未分类', description, content };
  }
  function lookup(store, id) {
    const item = store.templates.find(template => template.id === id && !template.deletedAt);
    if (!item) throw new RequestError('TEMPLATE_NOT_FOUND', '模板不存在或已删除，请刷新提示词库。', 404);
    return item;
  }
  function publicTemplate(template) {
    const { deletedAt, ...safe } = template;
    return { ...safe, variables: extractVariables(template.content) };
  }
  function checkRevision(body, item) {
    if (body.revision !== item.revision) throw new RequestError('TEMPLATE_CONFLICT', '模板已在其他窗口更新，请关闭编辑窗口、刷新列表后再修改。', 409);
  }
  return async (req, res, pathname) => {
    if (!pathname.startsWith('/api/prompts')) return false;
    if (pathname === '/api/prompts' && req.method === 'GET') {
      const store = await serialize(readStore);
      json(res, 200, { templates: store.templates.filter(item => !item.deletedAt).map(publicTemplate) });
      return true;
    }
    const match = pathname.match(/^\/api\/prompts\/([a-f0-9-]+)$/);
    if (match && req.method === 'GET') {
      const template = await serialize(async () => publicTemplate(lookup(await readStore(), match[1])));
      json(res, 200, { template });
      return true;
    }
    if ((pathname === '/api/prompts' && req.method === 'POST') || (match && req.method === 'PUT')) {
      const body = await readJson(req);
      const config = validate(body);
      const template = await serialize(async () => {
        const store = await readStore();
        const existing = match ? lookup(store, match[1]) : null;
        if (existing) checkRevision(body, existing);
        if (store.templates.some(item => !item.deletedAt && item.id !== existing?.id && item.name.toLocaleLowerCase() === config.name.toLocaleLowerCase())) throw new RequestError('DUPLICATE_TEMPLATE', '模板名称已存在，请换一个名称。', 409);
        const now = new Date().toISOString();
        const item = { id: existing?.id || randomUUID(), ...config, revision: (existing?.revision || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now };
        if (existing) store.templates[store.templates.indexOf(existing)] = item;
        else store.templates.push(item);
        await writeStore(store);
        return publicTemplate(item);
      });
      json(res, match ? 200 : 201, { ok: true, template });
      return true;
    }
    if (match && req.method === 'DELETE') {
      const body = await readJson(req);
      await serialize(async () => {
        const store = await readStore();
        const item = lookup(store, match[1]);
        checkRevision(body, item);
        item.deletedAt = new Date().toISOString();
        item.revision += 1;
        await writeStore(store);
      });
      json(res, 200, { ok: true });
      return true;
    }
    throw new RequestError('NOT_FOUND', '提示词库接口不存在或请求方法不正确。', 404);
  };
}
