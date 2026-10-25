import { node, renderRecord } from './review-render.js';
import { initReviewFields } from './review-fields.js';
import { initReviewDistribution } from './review-distribution.js';
const $ = id => document.getElementById(id);
let versions = [], active = null, page = 1, totalPages = 1, pageBusy = false, createBusy = false, deleteBusy = false, deleteTarget = null;
let listSequence = 0, versionSequence = 0, detailSequence = 0, listController, detailController, searchTimer;
let detailRecord = null, navigation = {};
let tableFields = [], deleteQuestionBusy = false, deleteQuestionTarget = null;
const fieldTools = initReviewFields({ endpoint: '/api/frozen-versions', readOnly: true, getDataset: () => active,
  isBusy: () => pageBusy || deleteQuestionBusy || deleteBusy,
  async onFilterChanged() { clearTimeout(searchTimer); page = 1; await loadQuestions(); }
});
const distribution = initReviewDistribution({ endpoint: '/api/frozen-versions', getDataset: () => active,
  getFilters: () => ({ query: $('frozen-search').value.trim(), difficulty: $('frozen-difficulty').value, family: $('frozen-family').value, ...fieldTools.getFilters() })
});
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const message = error => error.name === 'TimeoutError' ? '本地服务响应超时，请重试。' : error instanceof TypeError ? '无法连接本地工具，请确认服务正在运行。' : error.message;
function notice(text, kind = '') { $('frozen-notice').textContent = text; $('frozen-notice').className = 'notice ' + kind; $('frozen-notice').hidden = !text; }
async function get(url, signal) {
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  const data = await response.json(); if (!response.ok) throw Object.assign(new Error(data.error?.message || '读取失败，请重试。'), { code: data.error?.code }); return data;
}
function renderVersions() {
  $('version-count').textContent = versions.length;
  $('version-cards').replaceChildren(...versions.map(version => {
    const button = node('button', 'version-card'); button.type = 'button'; button.setAttribute('aria-pressed', String(active?.id === version.id));
    const top = node('div', 'version-card-top'); top.append(node('strong', '', version.name), node('span', '', version.questionCount + ' 题'));
    button.append(top, node('p', '', version.description || '暂无版本说明'), node('small', '', '创建于 ' + dateLabel(version.createdAt)));
    button.addEventListener('click', () => activate(version)); return button;
  }));
  $('versions-empty').hidden = !!versions.length;
}
function updateVersion(version) {
  versions = versions.map(item => item.id === version.id ? { ...item, ...version } : item);
  if (active?.id === version.id) {
    active = { ...active, ...version };
    fieldTools.update(active);
    $('active-version-time').textContent = '创建于 ' + dateLabel(active.createdAt) + ' · 最近更新 ' + dateLabel(active.updatedAt);
  }
  renderVersions();
}
function renderColumns(fields) {
  tableFields = fields;
  const columns = fields.map(key => { const heading = node('th', 'review-data-heading', key || '""'); heading.title = 'JSON 字段：' + key; heading.setAttribute('scope', 'col'); heading.style.width = '280px'; fieldTools.decorateHeading(heading, key); return heading; });
  const number = node('th', 'frozen-number-heading', '序号'), actions = node('th', 'frozen-actions-column', '操作');
  number.setAttribute('scope', 'col'); actions.setAttribute('scope', 'col');
  $('frozen-table-head').replaceChildren(number, ...columns, actions);
  $('frozen-question-table').style.width = Math.max(900, 230 + fields.length * 280) + 'px';
}
function recordCells(item) {
  const fields = new Map((item.fieldPreviews || []).map(field => [field.key, field]));
  return tableFields.map(key => {
    const cell = node('td', 'review-data-cell'), field = fields.get(key);
    if (!field) { const missing = node('span', 'review-missing-value', '—'); missing.title = '此题未包含字段“' + key + '”'; cell.append(missing); return cell; }
    const text = field.text + (field.truncated ? '…' : '');
    const clickable = field.isQuestion || field.isPrimary;
    const content = node(clickable ? 'button' : 'div', clickable ? 'question-text' : 'review-cell-value' + (['object', 'array'].includes(field.kind) ? ' structured' : ''), text);
    content.title = text;
    if (clickable) { content.type = 'button'; content.setAttribute('aria-label', '查看冻结第 ' + item.number + ' 题的 ' + key); content.addEventListener('click', () => openDetail(item.number)); }
    cell.append(content); return cell;
  });
}
async function loadVersions(preferredId = active?.id || new URLSearchParams(location.search).get('version')) {
  const sequence = ++versionSequence;
  $('versions-loading').hidden = false; $('refresh-versions').disabled = true;
  try {
    const data = await get('/api/frozen-versions'); if (sequence !== versionSequence) return;
    versions = data.versions; renderVersions();
    await activate(versions.find(version => version.id === preferredId) || versions[0] || null);
  } catch (error) { notice(message(error), 'error'); }
  finally { if (sequence === versionSequence) { $('versions-loading').hidden = true; $('refresh-versions').disabled = false; } }
}
async function activate(version) {
  distribution.reset();
  fieldTools.reset();
  clearTimeout(searchTimer); closeDetail(); listController?.abort(); listSequence += 1;
  active = version; renderVersions(); $('frozen-workspace').hidden = !version;
  $('delete-version').disabled = !version || deleteBusy;
  if (!version) return;
  $('active-version-name').textContent = version.name; $('active-version-description').textContent = version.description;
  $('active-version-time').textContent = '创建于 ' + dateLabel(version.createdAt) + ' · 最近更新 ' + dateLabel(version.updatedAt);
  $('export-version').href = '/api/frozen-versions/' + version.id + '/download';
  $('frozen-search').value = ''; $('frozen-difficulty').replaceChildren(new Option('全部难度', '')); $('frozen-family').replaceChildren(new Option('全部任务族', ''));
  page = 1; await loadQuestions(true);
}
async function loadQuestions(refreshFilters = false) {
  if (!active) return;
  listController?.abort(); listController = new AbortController(); const sequence = ++listSequence;
  const params = new URLSearchParams({ page: String(page), pageSize: $('frozen-page-size').value, query: $('frozen-search').value.trim(), difficulty: $('frozen-difficulty').value, family: $('frozen-family').value, ...fieldTools.getFilters() });
  pageBusy = true; $('frozen-rows').replaceChildren(); $('frozen-questions-loading').hidden = false; $('frozen-questions-empty').hidden = true;
  $('frozen-previous-page').disabled = $('frozen-next-page').disabled = true;
  try {
    const data = await get('/api/frozen-versions/' + active.id + '/questions?' + params, listController.signal); if (sequence !== listSequence) return;
    updateVersion(data.dataset); renderColumns(data.dataset.fieldNames || []);
    if (refreshFilters) {
      let changed = false;
      for (const [name, counts, title] of [['difficulty', data.dataset.difficulties, '全部难度'], ['family', data.dataset.families, '全部任务族']]) {
        const select = $('frozen-' + name), previous = select.value;
        select.replaceChildren(new Option(title, ''), ...Object.entries(counts).map(([key, count]) => new Option(key + '（' + count + '）', key)));
        select.value = Object.hasOwn(counts, previous) ? previous : ''; changed ||= select.value !== previous;
      }
      if (changed) return await loadQuestions();
    }
    page = data.page; totalPages = data.totalPages;
    $('frozen-question-count').textContent = data.total;
    $('frozen-rows').replaceChildren(...data.questions.map(item => {
      const row = node('tr'); row.append(node('td', 'question-number', String(item.number).padStart(3, '0')));
      const action = node('td', 'frozen-actions-column'); const view = node('button', 'view-question', '查看详情'); view.type = 'button'; view.setAttribute('aria-label', '冻结第 ' + item.number + ' 题详情'); view.addEventListener('click', () => openDetail(item.number));
      const remove = node('button', 'delete-frozen-question', '删除'); remove.type = 'button'; remove.setAttribute('aria-label', '删除冻结第 ' + item.number + ' 题'); remove.addEventListener('click', () => openDeleteQuestion(item));
      action.append(view, remove); row.append(...recordCells(item), action); return row;
    }));
    $('frozen-questions-empty').hidden = data.total > 0;
    $('frozen-questions-empty').textContent = data.dataset.questionCount ? '没有匹配的题目，可调整搜索或筛选条件。' : '此版本还没有题目，请在技术人员审核中点击“通过”并选择此版本。';
    const start = data.total ? (page - 1) * data.pageSize + 1 : 0;
    $('frozen-range').textContent = '共 ' + data.total + ' 题 · 当前 ' + start + '–' + Math.min(page * data.pageSize, data.total) + ' 题';
    $('frozen-page-position').textContent = page + ' / ' + totalPages;
    distribution.update(data.dataset);
  } catch (error) {
    if (sequence === listSequence && error.code === 'INVALID_FIELD_FILTER' && fieldTools.getFilters().fieldFilters) {
      fieldTools.reset(); notice('审核区的字段配置已更新，请重新选择分类筛选。'); return await loadQuestions(true);
    }
    if (error.name !== 'AbortError' && sequence === listSequence) notice(message(error), 'error');
  }
  finally { if (sequence === listSequence) { pageBusy = false; $('frozen-questions-loading').hidden = true; $('frozen-previous-page').disabled = page <= 1; $('frozen-next-page').disabled = page >= totalPages; } }
}
function switchTab(name, focus = false) {
  for (const tab of ['fields', 'json']) { const selected = name === tab; $('frozen-' + tab + '-tab').setAttribute('aria-selected', String(selected)); $('frozen-' + tab + '-tab').tabIndex = selected ? 0 : -1; $('frozen-' + tab + '-panel').hidden = !selected; }
  if (focus) $('frozen-' + name + '-tab').focus();
}
function closeDetail() { detailSequence += 1; detailController?.abort(); detailRecord = null; if ($('frozen-detail').open) $('frozen-detail').close(); }
async function openDetail(number) {
  if (!active) return;
  detailController?.abort(); detailController = new AbortController(); const sequence = ++detailSequence; const version = active;
  detailRecord = null; navigation = {}; $('frozen-copy-json').disabled = true; $('frozen-previous-question').disabled = $('frozen-next-question').disabled = true;
  $('frozen-detail-heading').textContent = '第 ' + number + ' 题'; $('frozen-detail-version').textContent = version.name; $('frozen-detail-meta').replaceChildren(); $('frozen-detail-position').textContent = '';
  $('frozen-fields-panel').replaceChildren(node('div', 'detail-loading', '正在读取题目...')); $('frozen-question-json').value = ''; switchTab('fields');
  $('frozen-fields-panel').scrollTop = 0; $('frozen-json-panel').scrollTop = 0;
  if (!$('frozen-detail').open) $('frozen-detail').showModal();
  try {
    const data = await get('/api/frozen-versions/' + version.id + '/questions/' + number, detailController.signal); if (sequence !== detailSequence) return;
    detailRecord = data.record; navigation = data.navigation;
    $('frozen-detail-heading').textContent = '第 ' + number + ' 题' + (data.summary.recordId ? ' · ' + data.summary.recordId : '');
    const meta = ['通过于：' + dateLabel(data.summary.approvedAt), '原评测集：' + data.summary.origin.datasetName + ' · 第 ' + data.summary.origin.number + ' 题'];
    $('frozen-detail-meta').replaceChildren(...meta.map(text => node('span', '', text)));
    $('frozen-fields-panel').replaceChildren(...renderRecord(data.record)); $('frozen-question-json').value = JSON.stringify(data.record, null, 2); $('frozen-copy-json').disabled = false;
    $('frozen-detail-position').textContent = '第 ' + data.navigation.position + ' / ' + data.navigation.total + ' 题';
    $('frozen-previous-question').disabled = !navigation.previous; $('frozen-next-question').disabled = !navigation.next;
  } catch (error) { if (error.name !== 'AbortError' && sequence === detailSequence) $('frozen-fields-panel').replaceChildren(node('div', 'detail-loading', message(error))); }
}
function openCreate() { $('create-version-form').reset(); $('create-version-error').hidden = true; $('create-version-dialog').showModal(); }
function closeCreate() { if (!createBusy) $('create-version-dialog').close(); }
function openDelete() {
  if (!active || deleteBusy) return;
  deleteTarget = { ...active }; $('delete-version-error').hidden = true;
  $('delete-version-summary').textContent = '版本：“' + deleteTarget.name + '” · 已收录 ' + deleteTarget.questionCount + ' 道题';
  $('delete-version-dialog').showModal(); $('cancel-delete-version').focus();
}
function closeDelete() { if (!deleteBusy) { deleteTarget = null; $('delete-version-dialog').close(); } }
function openDeleteQuestion(item) {
  if (!active || deleteQuestionBusy || deleteBusy) return;
  deleteQuestionTarget = { versionId: active.id, versionName: active.name, revision: active.revision, number: item.number };
  $('delete-frozen-question-summary').textContent = '版本：“' + active.name + '” · 第 ' + item.number + ' 题';
  $('delete-frozen-question-preview').textContent = item.question;
  $('delete-frozen-question-error').hidden = true; $('delete-frozen-question-dialog').showModal(); $('cancel-delete-frozen-question').focus();
}
function closeDeleteQuestion() { if (!deleteQuestionBusy) { deleteQuestionTarget = null; $('delete-frozen-question-dialog').close(); } }
for (const id of ['cancel-delete-frozen-question', 'close-delete-frozen-question']) $(id).addEventListener('click', closeDeleteQuestion);
$('delete-frozen-question-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDeleteQuestion(); });
$('delete-frozen-question-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!deleteQuestionTarget || deleteQuestionBusy) return;
  const target = deleteQuestionTarget; deleteQuestionBusy = true; $('delete-frozen-question-error').hidden = true;
  for (const id of ['confirm-delete-frozen-question', 'cancel-delete-frozen-question', 'close-delete-frozen-question']) $(id).disabled = true;
  try {
    const response = await fetch('/api/frozen-versions/' + target.versionId + '/questions/' + target.number, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: target.revision }), signal: AbortSignal.timeout(30000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '题目删除失败，请重试。');
    $('delete-frozen-question-dialog').close(); deleteQuestionTarget = null;
    updateVersion(data.dataset);
    if (active?.id === target.versionId) { closeDetail(); await loadQuestions(true); }
    notice('已从“' + target.versionName + '”删除第 ' + target.number + ' 题。', 'success');
  } catch (error) { $('delete-frozen-question-error').textContent = message(error); $('delete-frozen-question-error').hidden = false; }
  finally { deleteQuestionBusy = false; for (const id of ['confirm-delete-frozen-question', 'cancel-delete-frozen-question', 'close-delete-frozen-question']) $(id).disabled = false; }
});
$('delete-version').addEventListener('click', openDelete);
for (const id of ['close-delete-version', 'cancel-delete-version']) $(id).addEventListener('click', closeDelete);
$('delete-version-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDelete(); });
$('delete-version-form').addEventListener('submit', async event => {
  event.preventDefault(); if (deleteBusy || !deleteTarget) return;
  const target = deleteTarget;
  deleteBusy = true; $('delete-version-error').hidden = true;
  for (const id of ['confirm-delete-version', 'cancel-delete-version', 'close-delete-version', 'delete-version']) $(id).disabled = true;
  try {
    const response = await fetch('/api/frozen-versions/' + target.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: target.revision }), signal: AbortSignal.timeout(30000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '版本删除失败，请重试。');
    $('delete-version-dialog').close(); deleteTarget = null;
    versionSequence += 1;
    versions = versions.filter(version => version.id !== target.id);
    if (active?.id === target.id) { closeDetail(); listController?.abort(); listSequence += 1; active = null; $('frozen-workspace').hidden = true; }
    renderVersions();
    await loadVersions(active?.id || versions[0]?.id || null);
    notice('已删除版本“' + target.name + '”，审核区原题和其他版本已保留。', 'success');
  } catch (error) { $('delete-version-error').textContent = message(error); $('delete-version-error').hidden = false; }
  finally {
    deleteBusy = false;
    for (const id of ['confirm-delete-version', 'cancel-delete-version', 'close-delete-version']) $(id).disabled = false;
    $('delete-version').disabled = !active;
  }
});
for (const id of ['create-version', 'create-first-version']) $(id).addEventListener('click', openCreate);
for (const id of ['close-version-dialog', 'cancel-version-dialog']) $(id).addEventListener('click', closeCreate);
$('create-version-dialog').addEventListener('cancel', event => { event.preventDefault(); closeCreate(); });
$('create-version-form').addEventListener('submit', async event => {
  event.preventDefault(); if (createBusy) return;
  if (!$('version-name').value.trim()) { $('create-version-error').textContent = '请填写版本名称。'; $('create-version-error').hidden = false; $('version-name').focus(); return; }
  createBusy = true; $('version-fields').disabled = true; $('save-version').disabled = true; $('create-version-error').hidden = true;
  try {
    const response = await fetch('/api/frozen-versions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: $('version-name').value, description: $('version-description').value }), signal: AbortSignal.timeout(30000) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '版本创建失败。');
    $('create-version-dialog').close(); await loadVersions(data.version.id); notice('已创建版本“' + data.version.name + '”，可从技术人员审核收录题目。', 'success');
  } catch (error) { $('create-version-error').textContent = message(error); $('create-version-error').hidden = false; }
  finally { createBusy = false; $('version-fields').disabled = false; $('save-version').disabled = false; }
});
$('refresh-versions').addEventListener('click', () => { notice(''); loadVersions(); });
$('frozen-search').addEventListener('input', () => { clearTimeout(searchTimer); page = 1; searchTimer = setTimeout(() => loadQuestions(), 250); });
for (const id of ['frozen-difficulty', 'frozen-family', 'frozen-page-size']) $(id).addEventListener('change', () => { clearTimeout(searchTimer); page = 1; loadQuestions(); });
$('frozen-previous-page').addEventListener('click', () => { if (!pageBusy && page > 1) { page -= 1; loadQuestions(); } });
$('frozen-next-page').addEventListener('click', () => { if (!pageBusy && page < totalPages) { page += 1; loadQuestions(); } });
$('close-frozen-detail').addEventListener('click', closeDetail); $('frozen-detail').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('frozen-previous-question').addEventListener('click', () => { if (navigation.previous) openDetail(navigation.previous); }); $('frozen-next-question').addEventListener('click', () => { if (navigation.next) openDetail(navigation.next); });
for (const name of ['fields', 'json']) {
  $('frozen-' + name + '-tab').addEventListener('click', () => switchTab(name));
  $('frozen-' + name + '-tab').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); switchTab(event.key === 'Home' ? 'fields' : event.key === 'End' ? 'json' : name === 'fields' ? 'json' : 'fields', true); } });
}
$('frozen-copy-json').addEventListener('click', async () => {
  if (!detailRecord) return;
  try { await navigator.clipboard.writeText(JSON.stringify(detailRecord, null, 2)); $('frozen-copy-json').textContent = '已复制'; setTimeout(() => { $('frozen-copy-json').textContent = '复制 JSON'; }, 2000); }
  catch { switchTab('json'); $('frozen-question-json').focus(); $('frozen-question-json').select(); $('frozen-copy-json').textContent = '已选中，请按 Ctrl+C'; }
});
loadVersions();
