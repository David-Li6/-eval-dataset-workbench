import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findPython } from './files.mjs';
const parser = fileURLToPath(new URL('./extract_sources.py', import.meta.url));
export function extractSource(filename, name, signal) {
  return new Promise((resolve, reject) => {
    execFile(findPython(), [parser, filename, name], { windowsHide: true, signal, timeout: 60000, maxBuffer: 24 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } }, (error, stdout) => {
      if (error) return reject(new Error(signal?.aborted ? '生成已停止。' : '源文档读取失败或超时，请检查 Python 环境或拆分较大的文档。'));
      try { const result = JSON.parse(stdout); if (!result.ok) throw new Error(result.message); resolve(result); } catch (err) { reject(err); }
    });
  });
}
