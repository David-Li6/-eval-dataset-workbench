import { initSourceGeneration } from './source-generation.js';
const $ = id => document.getElementById(id);
let files = [];
let uploadQueue = [];
let uploading = false;
let batchTotal = 0;
let batchDone = 0;
let batchErrors = [];
let refreshVersion = 0;
let detailVersion = 0;
let activeFile = null;
let activePreview = null;
let deleteTarget = null;
let deleteBusy = false;
let rawMarkdown = false;
let noticeTimer;
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const sourceGeneration = initSourceGeneration({ notify });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function notify(message, kind = '') {
  clearTimeout(noticeTimer);
  $('file-notice').textContent = message;
  $('file-notice').className = 'notice ' + kind;
  $('file-notice').hidden = !message;
  if (kind === 'success') noticeTimer = setTimeout(() => { $('file-notice').hidden = true; }, 6000);
}
function sizeLabel(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
function typeInfo(file) {
  const ext = file.extension || '.' + file.name.split('.').pop().toLowerCase();
  if (['.xlsx', '.xls', '.xlsm', '.csv', '.tsv'].includes(ext)) return { className: 'excel', icon: ext.slice(1).toUpperCase(), label: ['.csv', '.tsv'].includes(ext) ? '数据表格' : 'Excel' };
  if (['.doc', '.docx'].includes(ext)) return { className: 'word', icon: 'W', label: 'Word' };
  if (['.md', '.markdown'].includes(ext)) return { className: 'markdown', icon: 'MD', label: 'Markdown' };
  if (ext === '.pdf') return { className: 'pdf', icon: 'PDF', label: 'PDF' };
  return { className: '', icon: ext.length > 1 && ext.length < 7 ? ext.slice(1).toUpperCase() : 'FILE', label: ext.length > 1 ? ext.slice(1).toUpperCase() : '文件' };
}
function dateLabel(value) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function renderFiles() {
  const query = $('file-search').value.trim().toLowerCase();
  const visible = files.filter(file => file.name.toLowerCase().includes(query));
  sourceGeneration.render(files, visible);
  $('file-count').textContent = files.length;
  $('library-summary').textContent = '共 ' + files.length + ' 个文件 · ' + sizeLabel(files.reduce((sum, file) => sum + file.size, 0));
  $('files-empty').hidden = visible.length > 0;
  $('empty-title').textContent = files.length ? '未找到匹配的文件' : '还没有上传文件';
  $('empty-description').textContent = files.length ? '请尝试其他文件名称。' : '上传的文件会显示在这里，点击文件名称即可查看详情。';
  $('file-rows').replaceChildren(...visible.map(file => {
    const info = typeInfo(file);
    const row = element('tr');
    const check = element('td', 'source-file-checkbox-cell'); check.append(sourceGeneration.checkbox(file)); row.append(check);
    const nameCell = element('td');
    const nameWrap = element('div', 'file-name-cell');
    const button = element('button', '', file.name);
    button.type = 'button';
    button.setAttribute('aria-label', '查看文件：' + file.name);
    button.addEventListener('click', () => openDetail(file));
    const nameText = element('div');
    nameText.append(button, element('small', '', file.previewSupported ? '可预览内容' : '可查看详情与下载原文件'));
    nameWrap.append(element('span', 'file-type-icon ' + info.className, info.icon), nameText);
    nameCell.append(nameWrap);
    row.append(nameCell, element('td', '', info.label), element('td', '', sizeLabel(file.size)), element('td', '', dateLabel(file.uploadedAt)));
    const actions = element('td');
    const wrap = element('div', 'file-actions');
    const view = element('button', '', '查看详情');
    view.type = 'button';
    view.setAttribute('aria-label', '文件详情：' + file.name);
    view.addEventListener('click', () => openDetail(file));
    const download = element('a', '', '下载');
    download.href = '/api/files/' + file.id + '/download';
    download.setAttribute('aria-label', '下载文件：' + file.name);
    const remove = element('button', 'delete-file', '删除');
    remove.type = 'button';
    remove.disabled = uploading || deleteBusy;
    remove.setAttribute('aria-label', '删除文件：' + file.name);
    remove.addEventListener('click', () => openDeleteFile(file));
    wrap.append(view, download, remove);
    actions.append(wrap);
    row.append(actions);
    return row;
  }));
}
async function loadFiles() {
  const version = ++refreshVersion;
  $('refresh-files').disabled = true;
  $('files-loading').hidden = files.length > 0;
  try {
    const response = await fetch('/api/files', { signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '读取文件列表失败。');
    if (version !== refreshVersion) return;
    files = data.files;
    renderFiles();
  } catch (error) { if (version === refreshVersion) notify(error.name === 'TimeoutError' ? '读取文件列表超时，请重试。' : error.message || '无法连接本地服务，请重新启动工具。', 'error'); }
  finally {
    if (version === refreshVersion) { $('files-loading').hidden = true; $('refresh-files').disabled = false; }
  }
}
function openDeleteFile(file) {
  if (uploading || deleteBusy) return;
  deleteTarget = file;
  $('delete-file-name').textContent = file.name;
  $('delete-file-metadata').textContent = sizeLabel(file.size) + ' · 上传于 ' + dateLabel(file.uploadedAt);
  $('delete-file-error').hidden = true;
  $('delete-file-dialog').showModal();
}
function closeDeleteFile() {
  if (deleteBusy) return;
  $('delete-file-dialog').close();
  deleteTarget = null;
}
async function confirmDeleteFile() {
  if (!deleteTarget || deleteBusy) return;
  const file = deleteTarget;
  deleteBusy = true;
  refreshVersion += 1;
  $('refresh-files').disabled = true;
  $('files-loading').hidden = true;
  $('delete-file-error').hidden = true;
  $('confirm-delete-file').disabled = true;
  $('cancel-delete-file').disabled = true;
  $('confirm-delete-file').textContent = '正在删除…';
  $('delete-file-dialog').setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/files/' + file.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok && !(response.status === 404 && data.error?.code === 'FILE_NOT_FOUND')) throw new Error(data.error?.message || '删除文件失败。');
    files = files.filter(item => item.id !== file.id);
    if (activeFile?.id === file.id) closeDetail();
    $('delete-file-dialog').close();
    deleteTarget = null;
    renderFiles();
    notify('已删除源文档“' + file.name + '”。已生成的评测集保留。', 'success');
    await loadFiles();
  } catch (error) {
    $('delete-file-error').textContent = error.name === 'TimeoutError' ? '删除请求超时，请重试或刷新列表确认结果。' : error.message || '无法连接本地服务，请重试。';
    $('delete-file-error').hidden = false;
  } finally {
    deleteBusy = false;
    $('refresh-files').disabled = false;
    $('confirm-delete-file').disabled = false;
    $('cancel-delete-file').disabled = false;
    $('confirm-delete-file').textContent = '确认删除';
    $('delete-file-dialog').setAttribute('aria-busy', 'false');
    renderFiles();
  }
}
function updateProgress(name, fraction = 0) {
  $('upload-title').textContent = '正在上传文件';
  $('upload-count').textContent = batchDone + ' / ' + batchTotal;
  $('upload-current').textContent = name;
  $('progress-fill').style.width = ((batchDone + fraction) / batchTotal * 100) + '%';
}
function uploadOne(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.timeout = 180000;
    xhr.upload.onprogress = event => { if (event.lengthComputable) updateProgress(file.name, event.loaded / event.total); };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('服务返回异常，请重新启动工具。')); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error?.message || '上传失败。'));
      resolve(data.file);
    };
    xhr.onerror = () => reject(new Error('网络中断，请检查本地工具是否正在运行。'));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试。'));
    xhr.onabort = () => reject(new Error('上传已中止。'));
    xhr.send(file);
  });
}
async function enqueueUploads(selected) {
  const incoming = [...selected];
  if (!incoming.length) return;
  if (!uploading) { batchTotal = 0; batchDone = 0; batchErrors = []; }
  uploadQueue.push(...incoming);
  batchTotal += incoming.length;
  $('file-search').value = '';
  renderFiles();
  $('upload-progress').hidden = false;
  $('upload-errors').hidden = true;
  notify('');
  if (uploading) return;
  uploading = true;
  renderFiles();
  let successful = 0;
  // Invalidate pending list reads so a slower refresh cannot erase newly uploaded rows.
  refreshVersion += 1;
  $('refresh-files').disabled = true;
  $('files-loading').hidden = true;
  while (uploadQueue.length) {
    const file = uploadQueue.shift();
    updateProgress(file.name);
    try {
      if (file.size > MAX_FILE_SIZE) throw new Error('超过单个文件 50 MB 的限制。');
      const saved = await uploadOne(file);
      files = [saved, ...files.filter(item => item.id !== saved.id)];
      successful += 1;
      renderFiles();
    } catch (error) { batchErrors.push(file.name + '：' + error.message); }
    batchDone += 1;
    updateProgress(file.name);
  }
  uploading = false;
  $('refresh-files').disabled = false;
  $('progress-fill').style.width = '100%';
  $('upload-title').textContent = batchErrors.length ? '上传完成，部分文件未成功' : '上传完成';
  $('upload-current').textContent = successful + ' 个文件已保存' + (batchErrors.length ? '，' + batchErrors.length + ' 个未上传' : '');
  $('upload-errors').textContent = batchErrors.join('\n');
  $('upload-errors').hidden = !batchErrors.length;
  notify(successful + ' 个文件已上传并保存在本机。' + (batchErrors.length ? '请查看下方未成功的文件说明。' : ''), batchErrors.length ? 'error' : 'success');
  await loadFiles();
}
function columnName(index) {
  let result = '';
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result;
  return result;
}
function dataTable(rows, numbered = true) {
  const table = element('table', 'data-table');
  if (numbered) {
    const head = element('thead');
    const heading = element('tr');
    heading.append(element('th', 'row-number', '#'));
    const width = Math.max(0, ...rows.map(row => row.length));
    for (let i = 0; i < width; i++) heading.append(element('th', '', columnName(i)));
    head.append(heading);
    table.append(head);
  }
  const body = element('tbody');
  rows.forEach((cells, index) => {
    const row = element('tr');
    if (numbered) row.append(element('td', 'row-number', index + 1));
    for (const cell of cells) row.append(element('td', '', cell));
    body.append(row);
  });
  table.append(body);
  return table;
}
function markdownPreview(text) {
  const container = element('article', 'document-preview');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let code = null;
  let list = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      if (code) { container.append(element('pre', '', code.join('\n'))); code = null; }
      else code = [];
      list = null;
      continue;
    }
    if (code) { code.push(line); continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { container.append(element('h' + heading[1].length, '', heading[2])); list = null; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[index + 1] || '')) {
      const split = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
      const rows = [split(line)];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) { rows.push(split(lines[index])); index += 1; }
      index -= 1;
      const wrap = element('div', 'doc-table-wrap'); wrap.append(dataTable(rows, false)); container.append(wrap); list = null; continue;
    }
    const item = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/);
    if (item) {
      if (!list) { list = element(/^\s*\d/.test(line) ? 'ol' : 'ul'); container.append(list); }
      list.append(element('li', '', item[1])); continue;
    }
    list = null;
    if (/^>\s?/.test(line)) container.append(element('blockquote', '', line.replace(/^>\s?/, '')));
    else if (line.trim()) container.append(element('p', '', line));
  }
  if (code) container.append(element('pre', '', code.join('\n')));
  return container;
}
function renderPreview(preview) {
  const content = $('preview-content');
  content.replaceChildren();
  $('markdown-controls').hidden = preview.kind !== 'markdown' || !preview.ok;
  if (!preview.ok || preview.kind === 'unsupported') { content.append(element('div', 'preview-message', preview.message || '暂不支持此文件的内容预览，可下载原文件查看。')); return; }
  if (preview.kind === 'table') {
    if (preview.rows.length) content.append(dataTable(preview.rows));
    else content.append(element('div', 'preview-message', '该表没有可显示的数据。'));
  } else if (preview.kind === 'document') {
    const documentView = element('article', 'document-preview');
    for (const block of preview.blocks) {
      if (block.type === 'table') { const wrap = element('div', 'doc-table-wrap'); wrap.append(dataTable(block.rows, false)); documentView.append(wrap); }
      else documentView.append(element(block.type === 'heading' ? 'h' + Math.min(6, Math.max(1, block.level)) : 'p', '', block.text));
    }
    if (preview.blocks.length) content.append(documentView);
    else content.append(element('div', 'preview-message', '文档没有可提取的正文。'));
  } else if (preview.kind === 'markdown' && !rawMarkdown) content.append(markdownPreview(preview.text));
  else content.append(preview.text ? element('pre', '', preview.text) : element('div', 'preview-message', '文件内容为空。'));
}
async function loadPreview(file, sheet) {
  const version = ++detailVersion;
  $('preview-content').setAttribute('aria-busy', 'true');
  $('preview-content').replaceChildren(element('div', 'preview-message', '正在读取文件内容...'));
  $('preview-note').hidden = true;
  $('markdown-controls').hidden = true;
  $('preview-stats').textContent = '';
  $('preview-sheet').disabled = true;
  try {
    const response = await fetch('/api/files/' + file.id + '/preview' + (sheet === undefined ? '' : '?sheet=' + encodeURIComponent(sheet)), { signal: AbortSignal.timeout(35000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '文件预览失败。');
    if (version !== detailVersion) return;
    activePreview = data.preview;
    const preview = data.preview;
    $('sheet-control').hidden = !preview.sheets?.length;
    if (preview.sheets?.length) {
      $('preview-sheet').replaceChildren(...preview.sheets.map(name => new Option(name, name)));
      $('preview-sheet').value = preview.sheet;
    }
    $('preview-stats').textContent = preview.kind === 'table' ? [preview.rowCount == null ? '已预览 ' + preview.rows.length + ' 行' : preview.rowCount + ' 行', preview.columnCount + ' 列'].join(' · ') : preview.pageCount ? preview.pageCount + ' 页' : preview.encoding || '';
    const notes = [];
    if (preview.message && preview.ok && preview.kind !== 'unsupported') notes.push(preview.message);
    if (preview.truncated) notes.push(preview.kind === 'table' ? '当前仅预览前 200 行、60 列及部分长文本，完整内容请下载原文件。' : '内容较长，当前显示部分预览，完整内容请下载原文件。');
    if (preview.sheetCount > 100) notes.push('当前列出前 100 个工作表。');
    $('preview-note').textContent = notes.join(' ');
    $('preview-note').hidden = !notes.length;
    renderPreview(preview);
  } catch (error) {
    if (version !== detailVersion) return;
    $('preview-content').replaceChildren(element('div', 'preview-message', error.name === 'TimeoutError' ? '预览超时，可下载原文件查看。' : error.message || '无法读取预览，请稍后重试。'));
  } finally {
    if (version === detailVersion) { $('preview-content').setAttribute('aria-busy', 'false'); $('preview-sheet').disabled = false; }
  }
}
function openDetail(file) {
  activeFile = file;
  activePreview = null;
  rawMarkdown = false;
  const info = typeInfo(file);
  $('detail-title').textContent = file.name;
  $('detail-icon').textContent = info.icon;
  $('detail-icon').className = 'file-type-icon ' + info.className;
  $('detail-subtitle').textContent = info.label + ' 文件';
  $('detail-size').textContent = '大小：' + sizeLabel(file.size);
  $('detail-date').textContent = '上传于：' + dateLabel(file.uploadedAt);
  $('download-file').href = '/api/files/' + file.id + '/download';
  $('sheet-control').hidden = true;
  $('show-rendered').setAttribute('aria-pressed', 'true');
  $('show-raw').setAttribute('aria-pressed', 'false');
  $('file-detail').showModal();
  loadPreview(file);
}
function closeDetail() { detailVersion += 1; $('file-detail').close(); activeFile = null; activePreview = null; }
for (const id of ['choose-top', 'choose-inline']) $(id).addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', () => { enqueueUploads($('file-input').files); $('file-input').value = ''; });
let dragDepth = 0;
$('drop-zone').addEventListener('dragenter', event => { event.preventDefault(); dragDepth += 1; $('drop-zone').classList.add('dragging'); });
$('drop-zone').addEventListener('dragleave', () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; $('drop-zone').classList.remove('dragging'); } });
$('drop-zone').addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
$('drop-zone').addEventListener('drop', event => { event.preventDefault(); dragDepth = 0; $('drop-zone').classList.remove('dragging'); enqueueUploads(event.dataTransfer.files); });
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('file-search').addEventListener('input', renderFiles);
$('refresh-files').addEventListener('click', () => { if (!uploading) { notify(''); loadFiles(); } });
$('cancel-delete-file').addEventListener('click', closeDeleteFile);
$('confirm-delete-file').addEventListener('click', confirmDeleteFile);
$('delete-file-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDeleteFile(); });
$('close-detail').addEventListener('click', closeDetail);
$('detail-done').addEventListener('click', closeDetail);
$('file-detail').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('preview-sheet').addEventListener('change', () => { if (activeFile) loadPreview(activeFile, $('preview-sheet').value); });
for (const [id, raw] of [['show-rendered', false], ['show-raw', true]]) $(id).addEventListener('click', () => {
  rawMarkdown = raw;
  $('show-rendered').setAttribute('aria-pressed', String(!raw));
  $('show-raw').setAttribute('aria-pressed', String(raw));
  if (activePreview) renderPreview(activePreview);
});
loadFiles();
