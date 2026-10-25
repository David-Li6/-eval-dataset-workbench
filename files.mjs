import { mkdir, readFile, writeFile, rename, open, unlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const parserPath = fileURLToPath(new URL('./preview_file.py', import.meta.url));
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const previewExtensions = new Set(['.csv', '.tsv', '.xlsx', '.xlsm', '.docx', '.pdf', '.md', '.markdown', '.txt', '.json', '.jsonl', '.log', '.yaml', '.yml', '.xml', '.html', '.htm', '.sql', '.py', '.js', '.css', '.ini', '.cfg']);

export function findPython() {
  if (process.env.EVAL_PYTHON) return process.env.EVAL_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}
export function runFilePreview(filename, name, sheet) {
  return new Promise(resolve => {
    execFile(findPython(), [parserPath, filename, name, ...(sheet == null ? [] : [sheet])], { windowsHide: true, timeout: 30000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout) => {
      if (error) return resolve({ ok: false, message: error.killed ? '文件预览超时，请下载原文件查看。' : '预览服务无法运行，请检查 Python 环境；原文件可下载。' });
      try { resolve(JSON.parse(stdout)); } catch { resolve({ ok: false, message: '文件预览返回异常，原文件仍可下载。' }); }
    });
  });
}

export function createFilesApi({ directory, readJson, json, RequestError, preview = runFilePreview }) {
  const indexPath = path.join(directory, 'index.json');
  let queue = Promise.resolve();
  const serialize = action => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
  const pendingPreviews = new Map();
  let parsing = 0;
  async function readIndex() {
    try {
      const value = JSON.parse(await readFile(indexPath, 'utf8'));
      if (value.version !== 1 || !Array.isArray(value.files)) throw new Error();
      return value;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, files: [] };
      throw new RequestError('FILES_STORE_ERROR', '文件列表无法读取，请检查本机文件存储，已有文件未被覆盖。', 500);
    }
  }
  async function writeIndex(index) {
    const temp = path.join(directory, randomUUID() + '.index.tmp');
    try {
      await writeFile(temp, JSON.stringify(index, null, 2) + '\n');
      await rename(temp, indexPath);
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }
  async function locate(id, { includeDeleted = false } = {}) {
    const index = await serialize(readIndex);
    const file = index.files.find(item => item.id === id && (includeDeleted || !item.deletedAt));
    if (!file) throw new RequestError('FILE_NOT_FOUND', '文件不存在，请刷新文件列表。', 404);
    const filename = path.join(directory, file.id + '.bin');
    try {
      const actual = await realpath(filename);
      const root = await realpath(directory);
      if (!actual.startsWith(root + path.sep)) throw new Error();
    } catch { throw new RequestError('FILE_NOT_FOUND', '原文件不存在或已移动，请重新上传。', 404); }
    return { file, filename };
  }
  function describe(file) {
    const extension = path.extname(file.name).toLowerCase();
    return { ...file, extension, previewSupported: previewExtensions.has(extension), generationSupported: previewExtensions.has(extension) };
  }
  const api = async (req, res, url) => {
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/files')) return false;
    if (pathname === '/api/files' && req.method === 'GET') {
      const index = await serialize(readIndex);
      json(res, 200, { files: index.files.filter(file => !file.deletedAt).map(describe).reverse(), maxFileSize: MAX_FILE_SIZE });
      return true;
    }
    if (pathname === '/api/files' && req.method === 'POST') {
      const name = url.searchParams.get('name') || '';
      if (!name.trim() || [...name].length > 240 || /[\\/\u0000-\u001f]/.test(name) || name === '.' || name === '..') throw new RequestError('INVALID_FILENAME', '文件名称无效或过长，请重命名后再上传。');
      if (!/^application\/octet-stream(?:;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError('INVALID_UPLOAD_TYPE', '上传请求格式错误，请使用页面中的文件上传功能。', 415);
      if (Number(req.headers['content-length']) > MAX_FILE_SIZE) { req.resume(); throw new RequestError('FILE_TOO_LARGE', '单个文件最多 50 MB，请选择较小文件。', 413); }
      await mkdir(directory, { recursive: true });
      const id = randomUUID();
      const temp = path.join(directory, id + '.upload.tmp');
      const destination = path.join(directory, id + '.bin');
      let size = 0;
      let handle;
      let moved = false;
      try {
        handle = await open(temp, 'wx');
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_FILE_SIZE) throw new RequestError('FILE_TOO_LARGE', '单个文件最多 50 MB，请选择较小文件。', 413);
          await handle.writeFile(chunk);
        }
        await handle.close(); handle = null;
        await rename(temp, destination); moved = true;
        const file = { id, name, size, uploadedAt: new Date().toISOString() };
        await serialize(async () => { const index = await readIndex(); index.files.push(file); await writeIndex(index); });
        json(res, 201, { ok: true, file: describe(file) });
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await unlink(moved ? destination : temp).catch(() => {});
        throw error;
      }
      return true;
    }
    const match = pathname.match(/^\/api\/files\/([a-f0-9-]+)(?:\/(preview|download))?$/);
    if (match && !match[2] && req.method === 'DELETE') {
      await readJson(req);
      await serialize(async () => {
        const index = await readIndex();
        const file = index.files.find(item => item.id === match[1] && !item.deletedAt);
        if (!file) throw new RequestError('FILE_NOT_FOUND', '文件已删除或不存在，请刷新文件列表。', 404);
        // Retain the original for jobs created before deletion; public access is removed.
        file.deletedAt = new Date().toISOString();
        await writeIndex(index);
      });
      json(res, 200, { ok: true });
      return true;
    }
    if (match && req.method === 'GET') {
      const { file, filename } = await locate(match[1]);
      if (match[2] === 'download') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': file.size, 'Content-Disposition': `attachment; filename="download${path.extname(file.name).replace(/[^.a-z0-9]/gi, '').slice(0, 12)}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
        createReadStream(filename).on('error', () => res.destroy()).pipe(res);
      } else if (match[2] === 'preview') {
        const sheet = url.searchParams.has('sheet') ? url.searchParams.get('sheet') : undefined;
        if (sheet?.length > 100) throw new RequestError('INVALID_SHEET', '工作表名称无效。');
        const key = file.id + ':' + JSON.stringify(sheet);
        if (!pendingPreviews.has(key)) {
          if (parsing >= 3) throw new RequestError('PREVIEW_BUSY', '正在预览其他文件，请稍后重试。', 429);
          parsing += 1;
          const task = Promise.resolve().then(() => preview(filename, file.name, sheet)).finally(() => { parsing -= 1; pendingPreviews.delete(key); });
          pendingPreviews.set(key, task);
        }
        json(res, 200, { file: describe(file), preview: await pendingPreviews.get(key) });
      } else json(res, 200, { file: describe(file) });
      return true;
    }
    throw new RequestError('NOT_FOUND', '文件接口不存在或请求方法不正确。', 404);
  };
  api.resolveFile = async (id, options) => { const result = await locate(id, options); return { ...result, file: describe(result.file) }; };
  return api;
}
