import { orderedReviewFields } from './review-utils.js';
import { node } from './review-render.js';

const $ = id => document.getElementById(id);
async function request(url, method, body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '操作失败，请重试。');
  return data;
}
const message = error => error.name === 'TimeoutError' ? '操作超时，请刷新确认结果后再试。' : error instanceof TypeError ? '无法连接本地工具，请确认服务正在运行。' : error.message;
function showError(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
const route = context => '/api/technical-reviews/' + context.dataset.id + '/questions/' + context.summary.number;
const isBatch = context => Array.isArray(context.summaries);
const items = context => isBatch(context) ? context.summaries : [context.summary];
const batchRoute = context => '/api/technical-reviews/' + context.dataset.id + '/batch';
const batchQuestions = context => context.summaries.map(({ number, revision }) => ({ number, revision }));
const numbersLabel = context => items(context).slice(0, 12).map(item => item.number).join('、') + (items(context).length > 12 ? ' 等' : '');

export function initReviewActions({ getCurrent, getSelection, onChanged, notify }) {
  let editContext, deleteContext, approveContext;
  let editBusy = false, deleteBusy = false, approveBusy = false, editMode = 'fields', approvalSequence = 0;
  let fieldInputs = [];
  function buildFields(record) {
    fieldInputs = [];
    $('edit-fields').replaceChildren(...orderedReviewFields(record).map((field, index) => {
      const value = record[field.key]; const text = typeof value === 'string';
      const section = node('div', 'field edit-question-field'); const label = node('label', '', field.key + ' · ' + field.label);
      const input = node('textarea'); input.id = 'edit-record-field-' + index; label.htmlFor = input.id; input.spellcheck = false;
      input.rows = text ? Math.min(9, Math.max(3, String(value).split('\n').length + 1)) : 6;
      input.value = text ? value : JSON.stringify(value, null, 2);
      section.append(label, input);
      if (!text) section.append(node('small', 'hint', 'JSON 格式；可填写对象、数组、数字、布尔值或 null。'));
      fieldInputs.push({ key: field.key, input, text }); return section;
    }));
  }
  function editorRecord() {
    let record;
    if (editMode === 'json') {
      try { record = JSON.parse($('edit-question-json').value); } catch { throw new Error('完整题目 JSON 格式有误，请检查引号、逗号和括号。'); }
    } else {
      record = Object.fromEntries(fieldInputs.map(field => {
        let value = field.input.value;
        if (!field.text) { try { value = JSON.parse(value); } catch { field.input.focus(); throw new Error('字段“' + field.key + '”不是有效 JSON，请检查后重试。'); } }
        return [field.key, value];
      }));
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('题目必须是一个 JSON 对象。');
    return record;
  }
  function changeMode(mode) {
    if (mode === editMode) return;
    try {
      const record = editorRecord();
      if (mode === 'json') $('edit-question-json').value = JSON.stringify(record, null, 2); else buildFields(record);
      editMode = mode; $('edit-fields').hidden = mode !== 'fields'; $('edit-json-panel').hidden = mode !== 'json';
      $('edit-fields-mode').setAttribute('aria-pressed', String(mode === 'fields')); $('edit-json-mode').setAttribute('aria-pressed', String(mode === 'json'));
      showError('edit-question-error');
    } catch (error) { showError('edit-question-error', error.message); }
  }
  function closeEditor() { if (!editBusy) $('question-editor').close(); }
  $('edit-question').addEventListener('click', () => {
    editContext = getCurrent(); if (!editContext) return;
    $('question-editor-title').textContent = '修改第 ' + editContext.summary.number + ' 题';
    editMode = 'fields'; $('edit-fields').hidden = false; $('edit-json-panel').hidden = true;
    $('edit-fields-mode').setAttribute('aria-pressed', 'true'); $('edit-json-mode').setAttribute('aria-pressed', 'false');
    buildFields(editContext.record); showError('edit-question-error'); $('question-editor').showModal();
  });
  $('edit-fields-mode').addEventListener('click', () => changeMode('fields')); $('edit-json-mode').addEventListener('click', () => changeMode('json'));
  for (const id of ['close-question-editor', 'cancel-question-editor']) $(id).addEventListener('click', closeEditor);
  $('question-editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
  $('question-edit-form').addEventListener('submit', async event => {
    event.preventDefault(); if (editBusy || !editContext) return;
    let record; try { record = editorRecord(); } catch (error) { showError('edit-question-error', error.message); return; }
    editBusy = true; $('edit-fieldset').disabled = true; $('save-question-edit').disabled = true; showError('edit-question-error');
    try {
      const data = await request(route(editContext), 'PUT', { record, revision: editContext.summary.revision });
      $('question-editor').close(); await onChanged(data, 'edit'); notify('第 ' + data.summary.number + ' 题已修改，当前内容待审核。', 'success');
    } catch (error) { showError('edit-question-error', message(error)); }
    finally { editBusy = false; $('edit-fieldset').disabled = false; $('save-question-edit').disabled = false; }
  });
  function closeDelete() { if (!deleteBusy) $('delete-question-dialog').close(); }
  function openDelete(context) {
    deleteContext = context; if (!deleteContext) return;
    $('delete-question-title').textContent = isBatch(context) ? '批量删除 ' + context.summaries.length + ' 道题' : '删除题目';
    $('confirm-delete-question').textContent = isBatch(context) ? '删除 ' + context.summaries.length + ' 道题' : '删除题目';
    $('delete-question-description').textContent = (isBatch(context) ? '确定删除选中的 ' + context.summaries.length + ' 道题吗？序号：' + numbersLabel(context) + '。' : '确定删除第 ' + context.summary.number + ' 题吗？') + '删除后将从审核列表移除。已收录到冻结版本的题目内容会保留。';
    showError('delete-question-error'); $('delete-question-dialog').showModal();
  }
  $('delete-question').addEventListener('click', () => openDelete(getCurrent()));
  $('batch-delete-questions').addEventListener('click', () => openDelete(getSelection()));
  $('cancel-delete-question').addEventListener('click', closeDelete); $('delete-question-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDelete(); });
  $('confirm-delete-question').addEventListener('click', async () => {
    if (deleteBusy || !deleteContext) return;
    deleteBusy = true; $('confirm-delete-question').disabled = true; showError('delete-question-error');
    try {
      const data = isBatch(deleteContext) ? await request(batchRoute(deleteContext), 'POST', { action: 'delete', questions: batchQuestions(deleteContext) }) : await request(route(deleteContext), 'DELETE', { revision: deleteContext.summary.revision });
      $('delete-question-dialog').close(); await onChanged(data, 'delete'); notify(data.affectedCount ? '已批量删除 ' + data.affectedCount + ' 道题。' : '第 ' + data.deletedNumber + ' 题已删除。', 'success');
    } catch (error) { showError('delete-question-error', message(error)); }
    finally { deleteBusy = false; $('confirm-delete-question').disabled = false; }
  });
  function chooseVersion() { $('new-approval-version').hidden = $('approval-version').value !== '__new__'; }
  function closeApproval() { if (!approveBusy) { approvalSequence += 1; $('approve-question-dialog').close(); } }
  async function openApproval(context) {
    approveContext = context; if (!approveContext) return;
    const incomplete = items(context).find(item => item.issues.length);
    if (incomplete) { notify('第 ' + incomplete.number + ' 题缺少问题或参考答案，请先补充或取消勾选，再通过审核。', 'error'); return; }
    const sequence = ++approvalSequence;
    $('approve-question-title').textContent = isBatch(context) ? '批量通过 · 选择冻结版本' : '选择冻结版本';
    $('confirm-approve-question').textContent = isBatch(context) ? '通过 ' + context.summaries.length + ' 题并加入版本' : '通过并加入版本';
    $('approve-question-description').textContent = isBatch(context) ? '选中 ' + context.summaries.length + ' 道题，序号：' + numbersLabel(context) + '。这些题目将统一加入所选版本。' : '第 ' + context.summary.number + ' 题 · ' + context.summary.question;
    $('approval-version').replaceChildren(new Option('正在读取版本...', '')); $('approval-version-name').value = ''; $('approval-version-description').value = '';
    $('new-approval-version').hidden = true; $('approve-fieldset').disabled = true; $('confirm-approve-question').disabled = true; showError('approve-question-error'); $('approve-question-dialog').showModal();
    try {
      const response = await fetch('/api/frozen-versions', { signal: AbortSignal.timeout(10000) }); const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '版本读取失败。');
      if (sequence !== approvalSequence) return;
      const included = new Map();
      for (const item of items(context)) for (const version of item.frozenVersions) included.set(version.id, (included.get(version.id) || 0) + 1);
      const options = data.versions.map(version => { const option = new Option(version.name + '（' + version.questionCount + ' 题）' + (included.has(version.id) ? ' · 已收录其中 ' + included.get(version.id) + ' 题' : ''), version.id); option.disabled = included.has(version.id); return option; });
      options.push(new Option('+ 创建新版本', '__new__')); $('approval-version').replaceChildren(...options);
      $('approval-version').value = options.find(option => !option.disabled).value;
      $('approve-fieldset').disabled = false; $('confirm-approve-question').disabled = false; chooseVersion();
    } catch (error) { if (sequence === approvalSequence) showError('approve-question-error', message(error)); }
  }
  $('approve-question').addEventListener('click', () => openApproval(getCurrent()));
  $('batch-approve-questions').addEventListener('click', () => openApproval(getSelection()));
  $('approval-version').addEventListener('change', chooseVersion);
  for (const id of ['close-approve-question', 'cancel-approve-question']) $(id).addEventListener('click', closeApproval);
  $('approve-question-dialog').addEventListener('cancel', event => { event.preventDefault(); closeApproval(); });
  $('approve-question-form').addEventListener('submit', async event => {
    event.preventDefault(); if (approveBusy || !approveContext) return;
    let versionId = $('approval-version').value;
    if (!versionId) return;
    if (versionId === '__new__' && !$('approval-version-name').value.trim()) { showError('approve-question-error', '请填写新版本名称。'); $('approval-version-name').focus(); return; }
    approveBusy = true; $('approve-fieldset').disabled = true; $('confirm-approve-question').disabled = true; showError('approve-question-error');
    try {
      if (versionId === '__new__') {
        const created = await request('/api/frozen-versions', 'POST', { name: $('approval-version-name').value, description: $('approval-version-description').value });
        versionId = created.version.id;
        $('approval-version').add(new Option(created.version.name, versionId), 0); $('approval-version').value = versionId; chooseVersion();
      }
      const data = isBatch(approveContext) ? await request(batchRoute(approveContext), 'POST', { action: 'approve', questions: batchQuestions(approveContext), versionId }) : await request(route(approveContext) + '/approve', 'POST', { revision: approveContext.summary.revision, versionId });
      $('approve-question-dialog').close(); await onChanged(data, 'approve'); notify((data.affectedCount ? '已批量通过 ' + data.affectedCount + ' 道题' : '第 ' + data.summary.number + ' 题已通过') + '，已加入“' + data.version.name + '”。', 'success');
    } catch (error) { showError('approve-question-error', message(error)); }
    finally { approveBusy = false; $('approve-fieldset').disabled = false; $('confirm-approve-question').disabled = false; }
  });
}
