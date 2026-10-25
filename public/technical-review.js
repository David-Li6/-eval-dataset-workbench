import { renderRecord, renderExpertAdvice } from './review-render.js';
import { initReviewActions } from './review-actions.js';
import { initQuestionSelection } from './review-selection.js';
import { initExpertActions } from './expert-review.js';
import { identifyReviewFields } from './review-utils.js';
import { initReviewFields } from './review-fields.js';
import { initReviewDistribution } from './review-distribution.js';

const $ = id => document.getElementById(id);
const expertMode = !!$('expert-review-page');
const reviewApi = expertMode ? '/api/expert-reviews' : '/api/technical-reviews';
let datasets = [];
let activeDataset = null;
let uploadBusy = false;
let deleteDatasetBusy = false, deleteDatasetTarget = null;
let datasetsVersion = 0;
let questionsVersion = 0;
let detailVersion = 0;
let questionController;
let detailController;
let searchTimer;
let noticeTimer;
let currentPage = 1;
let totalPages = 1;
let pageBusy = false;
let detailNumber = 0;
let detailRecord = null;
let detailBusy = false;
let detailData = null;
let detailNavigation = {};
let expertActions = null;
let deepLinkOpened = false;
let fieldConfigLinkOpened = false;
let tableFields = [], tableSignature = '';
const fixedHeaders = [$('review-selection-heading'), $('review-number-heading')];
const selection = initQuestionSelection({ getDataset: () => activeDataset, getFilters: getQuestionFilters, notify, endpoint: reviewApi, ...(expertMode ? { actionIds: ['batch-submit-expert'] } : {}) });
const fieldTools = initReviewFields({ endpoint: reviewApi, getDataset: () => activeDataset, isBusy: () => uploadBusy || deleteDatasetBusy || !!expertActions?.busy(), notify,
  async onFilterChanged() { selection.reset(); clearTimeout(searchTimer); currentPage = 1; tableSignature = ''; if (activeDataset) renderTableColumns(activeDataset.fieldNames || []); await loadQuestions(); },
  async onSaved(dataset) { selection.reset(); currentPage = 1; updateDatasetStats(dataset); await loadQuestions(); }
});
const distribution = initReviewDistribution({ endpoint: reviewApi, getDataset: () => activeDataset, getFilters: getQuestionFilters });

function getQuestionFilters() {
  return { query: $('question-search').value.trim(), issues: $('issue-filter').value, status: $('status-filter').value, advice: $('advice-filter').value, ...fieldTools.getFilters(), ...(expertMode ? { expertStatus: $('expert-status-filter').value } : {}) };
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function notify(text, kind = '') {
  clearTimeout(noticeTimer);
  $('review-notice').textContent = text; $('review-notice').className = 'notice ' + kind; $('review-notice').hidden = !text;
  if (kind === 'success') noticeTimer = setTimeout(() => { $('review-notice').hidden = true; }, 6500);
}
function errorMessage(error) {
  if (error.name === 'TimeoutError') return '本地服务响应超时，请重试。';
  if (error instanceof TypeError) return '无法连接本地工具，请运行“启动工具.cmd”后重试。';
  return error.message || '操作失败，请重试。';
}
async function responseData(response) {
  const data = await response.json().catch(() => { throw new Error('本地服务返回异常，请重新启动工具。'); });
  if (!response.ok) throw Object.assign(new Error(data.error?.message || '请求未成功。'), { code: data.error?.code });
  return data;
}
function sizeLabel(bytes) { return bytes < 1024 * 1024 ? (bytes / 1024).toFixed(1) + ' KB' : (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
function updateDatasetSelect() {
  $('dataset-select').replaceChildren(...(datasets.length ? datasets.map(item => new Option(item.name + '（' + item.questionCount + ' 题）', item.id)) : [new Option('暂无评测集', '')]));
  $('dataset-select').disabled = !datasets.length || uploadBusy || deleteDatasetBusy || !!expertActions?.busy();
  if (activeDataset && datasets.some(item => item.id === activeDataset.id)) $('dataset-select').value = activeDataset.id;
  $('delete-dataset').hidden = !activeDataset;
  $('delete-dataset').disabled = !activeDataset || uploadBusy || deleteDatasetBusy || !!expertActions?.busy();
  $('configure-review-fields').disabled = !activeDataset || uploadBusy || deleteDatasetBusy || !!expertActions?.busy();
}
function updateFilters() {
  $('question-search').value = ''; $('issue-filter').value = ''; $('advice-filter').value = ''; $('status-filter').value = expertMode ? '' : 'pending';
  if (expertMode) $('expert-status-filter').value = '';
}
function updateDatasetStats(dataset) {
  activeDataset = dataset;
  fieldTools.update(dataset);
  datasets = datasets.map(item => item.id === dataset.id ? dataset : item);
  updateDatasetSelect();
  $('stat-questions').textContent = dataset.questionCount;
  $('stat-issues').textContent = dataset.issueCount;
  $('stat-approved').textContent = expertMode ? dataset.expertAdviceCount || 0 : dataset.approvedCount || 0;
  $('stat-pending').textContent = expertMode ? (dataset.expertDraftCount || 0) + ' 道题有草稿 · ' + (dataset.expertUnsubmittedCount || 0) + ' 道题尚未填写' : (dataset.pendingCount || 0) + ' 道题待审核';
  $('stat-deleted').textContent = dataset.deletedCount ? '已删除 ' + dataset.deletedCount + ' 题 · 保留原序号' : '按原文件顺序展示';
  renderTableColumns(dataset.fieldNames || []);
}
function activateDataset(dataset) {
  distribution.reset();
  fieldTools.reset();
  closeDetail();
  selection.reset();
  clearTimeout(searchTimer);
  questionController?.abort(); questionsVersion += 1;
  pageBusy = false;
  activeDataset = dataset;
  updateDatasetSelect();
  $('review-empty').hidden = !!dataset; $('dataset-workspace').hidden = !dataset; $('download-dataset').hidden = !dataset;
  if (!dataset) { $('dataset-info').textContent = ''; return; }
  $('dataset-info').textContent = sizeLabel(dataset.size) + ' · ' + dataset.format;
  $('download-dataset').href = '/api/technical-reviews/' + dataset.id + '/download';
  $('download-dataset').textContent = /\.jsonl$/i.test(dataset.name) ? '下载原始 JSONL' : '下载原始 JSON';
  updateDatasetStats(dataset);
  updateFilters(); currentPage = 1; return loadQuestions();
}
async function loadDatasets() {
  const version = ++datasetsVersion;
  $('refresh-datasets').disabled = true; $('review-loading').hidden = !!activeDataset;
  try {
    const data = await responseData(await fetch(reviewApi, { signal: AbortSignal.timeout(10000) }));
    if (version !== datasetsVersion) return false;
    const previousId = activeDataset?.id || new URLSearchParams(location.search).get('dataset');
    datasets = data.datasets;
    updateDatasetSelect();
    await activateDataset(datasets.find(item => item.id === previousId) || datasets[0] || null);
    const params = new URLSearchParams(location.search);
    if (!fieldConfigLinkOpened && params.get('configureFields') === '1' && activeDataset?.id === params.get('dataset')) {
      const task = fieldTools.openConfig();
      if ($('review-fields-dialog').open) {
        fieldConfigLinkOpened = true;
        const cleanUrl = new URL(location.href); cleanUrl.searchParams.delete('configureFields');
        globalThis.history?.replaceState(globalThis.history.state, '', cleanUrl.href);
      }
      await task;
    }
    if (!deepLinkOpened && activeDataset && !$('review-fields-dialog').open) {
      deepLinkOpened = true; const question = new URLSearchParams(location.search).get('question');
      if (question && /^\d+$/.test(question) && Number(question) > 0) openQuestion(Number(question));
    }
    return true;
  } catch (error) { notify(errorMessage(error), 'error'); return false; }
  finally { if (version === datasetsVersion) { $('review-loading').hidden = true; $('refresh-datasets').disabled = uploadBusy; } }
}
function openDeleteDataset() {
  if (!activeDataset || uploadBusy || deleteDatasetBusy || expertActions?.busy()) return;
  deleteDatasetTarget = { ...activeDataset }; $('delete-dataset-error').hidden = true;
  $('delete-dataset-summary').textContent = '评测集：“' + deleteDatasetTarget.name + '”';
  $('delete-dataset-count').textContent = '当前 ' + deleteDatasetTarget.questionCount + ' 题 · 原始 ' + (deleteDatasetTarget.originalQuestionCount ?? deleteDatasetTarget.questionCount) + ' 题';
  $('delete-dataset-dialog').showModal(); $('cancel-delete-dataset').focus();
}
function closeDeleteDataset() { if (!deleteDatasetBusy) { deleteDatasetTarget = null; $('delete-dataset-dialog').close(); } }
$('delete-dataset').addEventListener('click', openDeleteDataset);
for (const id of ['cancel-delete-dataset', 'close-delete-dataset']) $(id).addEventListener('click', closeDeleteDataset);
$('delete-dataset-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDeleteDataset(); });
$('delete-dataset-form').addEventListener('submit', async event => {
  event.preventDefault(); if (!deleteDatasetTarget || deleteDatasetBusy) return;
  const target = deleteDatasetTarget; deleteDatasetBusy = true; $('delete-dataset-error').hidden = true; updateDatasetSelect();
  for (const id of ['confirm-delete-dataset', 'cancel-delete-dataset', 'close-delete-dataset']) $(id).disabled = true;
  try {
    await responseData(await fetch(reviewApi + '/' + target.id, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: target.revision }), signal: AbortSignal.timeout(30000) }));
    $('delete-dataset-dialog').close(); deleteDatasetTarget = null; datasetsVersion += 1;
    datasets = datasets.filter(dataset => dataset.id !== target.id);
    if (activeDataset?.id === target.id) activateDataset(null);
    const refreshed = await loadDatasets();
    notify('已删除评测集“' + target.name + '”，两个审核页同步移除，冻结版本已保留。' + (refreshed ? '' : '列表刷新失败，请点击刷新重试。'), refreshed ? 'success' : 'error');
  } catch (error) { $('delete-dataset-error').textContent = errorMessage(error); $('delete-dataset-error').hidden = false; }
  finally {
    deleteDatasetBusy = false;
    for (const id of ['confirm-delete-dataset', 'cancel-delete-dataset', 'close-delete-dataset']) $(id).disabled = false;
    updateDatasetSelect();
  }
});
function setUploadBusy(value) {
  uploadBusy = value;
  if (value) selection.reset();
  selection.setLoading(value || pageBusy);
  for (const id of ['upload-dataset', 'choose-dataset', 'upload-first-dataset', 'refresh-datasets', 'dataset-input']) $(id).disabled = value;
  updateDatasetSelect();
}
function sendDataset(file) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/technical-reviews?name=' + encodeURIComponent(file.name));
    xhr.setRequestHeader('Content-Type', 'application/octet-stream'); xhr.timeout = 120000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) {
        const percent = Math.round(event.loaded / event.total * 100);
        $('progress-value').style.width = percent + '%';
        $('progress-message').textContent = percent >= 100 ? '上传完成，正在识别题目...' : '正在上传：' + percent + '%';
      }
    };
    xhr.onload = () => {
      let data;
      try { data = JSON.parse(xhr.responseText); } catch { return reject(new Error('本地服务返回异常，请重试。')); }
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error?.message || '评测集识别失败。'));
      resolve(data.dataset);
    };
    xhr.onerror = () => reject(new Error('上传中断，请确认本地工具正在运行。'));
    xhr.ontimeout = () => reject(new Error('上传超时，请重试。'));
    xhr.send(file);
  });
}
async function importDataset(file) {
  if (!file) return;
  if (uploadBusy) { notify('正在识别评测集，请稍候。'); return; }
  if (!/\.(json|jsonl)$/i.test(file.name)) { notify('请选择 .json 或 .jsonl 格式的评测集文件。', 'error'); return; }
  if (file.size > 20 * 1024 * 1024) { notify('单个 JSON / JSONL 评测集最多 20 MB。', 'error'); return; }
  datasetsVersion += 1;
  setUploadBusy(true); notify('');
  $('dataset-progress').hidden = false; $('progress-value').style.width = '0%'; $('progress-message').textContent = '正在上传并识别 ' + file.name;
  let imported = false;
  try {
    const dataset = await sendDataset(file);
    datasets = [dataset, ...datasets.filter(item => item.id !== dataset.id)];
    await activateDataset(dataset); imported = true;
    notify('已识别 ' + dataset.questionCount + ' 道题，原文件已保存。' + (dataset.issueCount ? '其中 ' + dataset.issueCount + ' 道题存在问题或参考答案缺失，可筛选查看。' : ''), 'success');
  } catch (error) { notify(errorMessage(error), 'error'); }
  finally { setUploadBusy(false); $('dataset-progress').hidden = true; $('review-loading').hidden = true; }
  if (imported) await fieldTools.openConfig();
}
function renderTableColumns(fields) {
  const signature = JSON.stringify([fields, activeDataset?.fieldSettings, fieldTools.getFilters()]); if (signature === tableSignature) return;
  tableSignature = signature; tableFields = fields;
  const identified = identifyReviewFields(Object.fromEntries(fields.map(key => [key, null])));
  const widths = new Map();
  for (const [canonical, width] of [['Question', 340], ['User Question', 300], ['answer', 300], ['Scoring criteria', 300], ['SELECT Data', 260], ['difficulty', 100], ['Task family', 150], ['source', 180], ['id', 120]]) if (identified[canonical] !== undefined) widths.set(identified[canonical], width);
  const columns = fields.map(key => { const heading = node('th', 'review-data-heading', key || '""'); heading.title = 'JSON 字段：' + key; heading.setAttribute('scope', 'col'); heading.style.width = (widths.get(key) || 220) + 'px'; fieldTools.decorateHeading(heading, key); return heading; });
  const advice = node('th', 'review-advice-column', fields.includes('专家建议') ? '专家建议（审核）' : '专家建议');
  advice.title = '业务专家在审核流程中提交的建议';
  const status = node('th', 'review-status-column', expertMode ? '建议状态' : '审核状态');
  const actions = node('th', 'review-actions-column', '操作');
  for (const heading of [...fixedHeaders, advice, status, actions]) heading.setAttribute('scope', 'col');
  $('review-table-head').replaceChildren(...fixedHeaders, ...columns, advice, status, actions);
  $('review-question-table').style.width = Math.max(1000, 111 + 400 + fields.reduce((sum, key) => sum + (widths.get(key) || 220), 0)) + 'px';
}
function recordCells(item) {
  const values = new Map((item.fieldPreviews || []).map(field => [field.key, field]));
  return tableFields.map(key => {
    const cell = node('td', 'review-data-cell'); const field = values.get(key);
    if (!field) { const missing = node('span', 'review-missing-value', '—'); missing.title = '此题未包含字段“' + key + '”'; cell.append(missing); return cell; }
    const text = field.text + (field.truncated ? '…' : '');
    const content = node(field.isQuestion || field.isPrimary ? 'button' : 'div', field.isQuestion || field.isPrimary ? 'question-text' : 'review-cell-value' + (['object', 'array'].includes(field.kind) ? ' structured' : ''), text);
    content.title = text + (field.truncated ? '\n内容较长，点击“查看详情”读取完整值。' : '');
    if (field.isQuestion || field.isPrimary) { content.type = 'button'; content.setAttribute('aria-label', field.isPrimary ? '查看第 ' + item.number + ' 题' : '查看第 ' + item.number + ' 题的 ' + key); content.addEventListener('click', () => openQuestion(item.number)); }
    cell.append(content);
    if (field.isPrimary && item.issues.length) { const warning = node('span', 'question-warning', '字段需确认'); warning.title = item.issues.join('；'); cell.append(warning); }
    return cell;
  });
}
function renderQuestions(data) {
  updateDatasetStats(data.dataset);
  currentPage = data.page; totalPages = data.totalPages;
  $('question-list-count').textContent = data.total;
  selection.renderPage(data.questions, data.total);
  $('question-rows').replaceChildren(...data.questions.map(item => {
    const row = node('tr');
    const checkCell = node('td', 'question-checkbox-cell'); checkCell.append(selection.checkbox(item)); row.append(checkCell);
    row.append(node('td', 'question-number', String(item.number).padStart(3, '0')));
    const action = node('td', 'review-actions-column'); const view = node('button', 'view-question', '查看详情'); view.type = 'button'; view.setAttribute('aria-label', '第 ' + item.number + ' 题详情'); view.addEventListener('click', () => openQuestion(item.number)); action.append(view);
    const status = node('td', 'review-status-column'); status.append(node('span', 'review-status ' + (expertMode ? item.expertStatus === 'submitted' ? 'approved' : 'pending' : item.status), expertMode ? item.expertStatus === 'draft' ? '有草稿' : item.expertStatus === 'submitted' ? '已提交' : '尚未填写' : item.status === 'approved' ? '已通过' : '待审核'));
    const advice = node('td', 'review-advice-column'); advice.append(node('span', 'expert-advice-preview' + (item.expertAdvice ? '' : ' empty'), item.expertAdvice?.preview || '暂无已提交建议'));
    if (item.expertAdvice) advice.append(node('small', 'expert-advice-subtitle', item.expertAdvice.isCurrent ? '已提交给技术人员' : '建议提交后题目已修改'));
    if (expertMode && item.draftOutdated) status.append(node('small', 'question-warning', '题目已修改，请核对草稿'));
    row.append(...recordCells(item), advice, status, action); return row;
  }));
  $('questions-empty').hidden = data.total > 0;
  $('questions-empty').textContent = !data.dataset.questionCount ? '题目已全部删除，上传时的原文件仍可下载。' : $('status-filter').value === 'pending' && !data.dataset.pendingCount ? '已无待审核题目，可切换“已通过”查看，或前往“冻结评测集”。' : '没有找到匹配的题目，可调整搜索或筛选条件。';
  const start = data.total ? (data.page - 1) * data.pageSize + 1 : 0; const end = Math.min(data.page * data.pageSize, data.total);
  $('question-range').textContent = '共 ' + data.total + ' 题 · 当前 ' + start + '–' + end + ' 题';
  $('page-position').textContent = data.page + ' / ' + data.totalPages;
  distribution.update(data.dataset);
}
async function loadQuestions() {
  if (!activeDataset) return;
  questionController?.abort(); questionController = new AbortController();
  const version = ++questionsVersion;
  const params = new URLSearchParams({ page: String(currentPage), pageSize: $('page-size').value, ...getQuestionFilters() });
  selection.setLoading(true);
  pageBusy = true; $('questions-loading').hidden = false; $('questions-empty').hidden = true;
  $('question-rows').replaceChildren(); $('previous-page').disabled = $('next-page').disabled = true;
  try {
    const data = await responseData(await fetch(reviewApi + '/' + activeDataset.id + '/questions?' + params, { signal: AbortSignal.any([questionController.signal, AbortSignal.timeout(15000)]) }));
    if (version !== questionsVersion) return;
    renderQuestions(data);
  } catch (error) {
    if (error.name !== 'AbortError' && version === questionsVersion) {
      if (error.code === 'DATASET_NOT_FOUND') { activateDataset(null); await loadDatasets(); notify('此评测集已在其他页面删除，列表已刷新。'); }
      else if (error.code === 'INVALID_FIELD_FILTER') { fieldTools.reset(); selection.reset(); await loadQuestions(); notify('字段配置已更新，已清除失效筛选，请重新选择。'); }
      else notify(errorMessage(error), 'error');
    }
  }
  finally {
    if (version === questionsVersion) { pageBusy = false; selection.setLoading(uploadBusy || !!expertActions?.busy()); $('questions-loading').hidden = true; $('previous-page').disabled = currentPage <= 1 || !!expertActions?.busy(); $('next-page').disabled = currentPage >= totalPages || !!expertActions?.busy(); }
  }
}
function switchDetailTab(tab, focus = false) {
  for (const name of ['fields', 'json']) {
    const selected = name === tab;
    $(name + '-tab').setAttribute('aria-selected', String(selected)); $(name + '-tab').tabIndex = selected ? 0 : -1; $(name + '-panel').hidden = !selected;
  }
  if (focus) $(tab + '-tab').focus();
}
function updateApprovalInfo(summary) {
  $('detail-approval-info').hidden = !summary.frozenVersions.length;
  const currentVersions = summary.approvedVersions;
  const historicalVersions = summary.frozenVersions.filter(item => !currentVersions.some(current => current.id === item.id));
  $('detail-approval-info').textContent = summary.status === 'approved' ? '当前内容已收录：' + currentVersions.map(item => item.name).join('、') + (historicalVersions.length ? '；历史内容：' + historicalVersions.map(item => item.name).join('、') : '') : '此题的历史内容已收录，当前题目待审核：' + historicalVersions.map(item => item.name).join('、');
}
async function openQuestion(number) {
  if (!activeDataset || expertActions?.busy()) return;
  detailController?.abort(); detailController = new AbortController();
  const version = ++detailVersion; const dataset = activeDataset;
  detailNumber = number; detailRecord = null; detailData = null; detailNavigation = {}; detailBusy = true;
  if (expertMode) expertActions.clear(); else for (const id of ['edit-question', 'delete-question', 'approve-question']) $(id).disabled = true;
  $('detail-approval-info').hidden = true;
  $('detail-heading').textContent = '第 ' + number + ' 题'; $('detail-dataset-name').textContent = dataset.name;
  $('detail-meta').replaceChildren(); $('detail-issues').hidden = true; $('question-json').value = '';
  $('copy-question-json').disabled = true; $('previous-question').disabled = $('next-question').disabled = true;
  $('detail-position').textContent = '第 ' + number + ' / ' + dataset.questionCount + ' 题';
  $('fields-panel').replaceChildren(node('div', 'detail-loading', '正在读取完整题目...'));
  $('fields-panel').scrollTop = 0; $('json-panel').scrollTop = 0;
  switchDetailTab('fields');
  if (!$('question-detail').open) $('question-detail').showModal();
  try {
    const data = await responseData(await fetch(reviewApi + '/' + dataset.id + '/questions/' + number, { signal: AbortSignal.any([detailController.signal, AbortSignal.timeout(15000)]) }));
    if (version !== detailVersion) return;
    detailRecord = data.record; detailData = data; detailNavigation = data.navigation;
    updateDatasetStats(data.dataset);
    $('detail-heading').textContent = '第 ' + number + ' 题' + (data.summary.recordId ? ' · ' + data.summary.recordId : '');
    const meta = ['审核状态：' + (data.summary.status === 'approved' ? '已通过' : '待审核')];
    $('detail-meta').replaceChildren(...meta.map(text => node('span', '', text)));
    $('detail-issues').textContent = '识别提示：' + data.summary.issues.join('；'); $('detail-issues').hidden = !data.summary.issues.length;
    $('fields-panel').replaceChildren(...(expertMode ? [] : [renderExpertAdvice(data.expertAdvice)]), ...renderRecord(data.record));
    if (!Object.keys(data.record).length) $('fields-panel').append(node('div', 'detail-loading', '此题为一个空对象 {}，请核对原始评测集。'));
    $('question-json').value = JSON.stringify(data.record, null, 2);
    $('copy-question-json').disabled = false;
    if (expertMode) expertActions.load(data); else for (const id of ['edit-question', 'delete-question', 'approve-question']) $(id).disabled = false;
    updateApprovalInfo(data.summary);
    $('detail-position').textContent = '第 ' + number + ' 题 · 当前 ' + data.navigation.position + ' / ' + data.navigation.total;
  } catch (error) {
    if (error.name !== 'AbortError' && version === detailVersion) $('fields-panel').replaceChildren(node('div', 'detail-loading', errorMessage(error)));
  } finally {
    if (version === detailVersion) { detailBusy = false; $('previous-question').disabled = !detailNavigation.previous; $('next-question').disabled = !detailNavigation.next; }
  }
}
function closeDetail() {
  if (expertActions?.busy()) return;
  detailVersion += 1; detailController?.abort(); detailRecord = null; detailData = null; detailBusy = false;
  if ($('question-detail').open) $('question-detail').close();
  if (expertMode) expertActions.clear();
}
for (const id of ['upload-dataset', 'choose-dataset', 'upload-first-dataset']) $(id).addEventListener('click', () => { if (!uploadBusy) $('dataset-input').click(); });
$('dataset-input').addEventListener('change', () => { importDataset($('dataset-input').files[0]); $('dataset-input').value = ''; });
let dragDepth = 0;
$('dataset-drop').addEventListener('dragenter', event => { event.preventDefault(); dragDepth += 1; $('dataset-drop').classList.add('dragging'); });
$('dataset-drop').addEventListener('dragover', event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; });
$('dataset-drop').addEventListener('dragleave', () => { dragDepth -= 1; if (dragDepth <= 0) { dragDepth = 0; $('dataset-drop').classList.remove('dragging'); } });
$('dataset-drop').addEventListener('drop', event => {
  event.preventDefault(); dragDepth = 0; $('dataset-drop').classList.remove('dragging');
  if (event.dataTransfer.files.length > 1) { notify('请每次选择一个 JSON / JSONL 评测集，导入后可通过下拉框切换。', 'error'); return; }
  importDataset(event.dataTransfer.files[0]);
});
for (const type of ['dragover', 'drop']) document.addEventListener(type, event => { if ([...event.dataTransfer.types].includes('Files')) event.preventDefault(); });
$('dataset-select').addEventListener('change', () => activateDataset(datasets.find(item => item.id === $('dataset-select').value) || null));
$('refresh-datasets').addEventListener('click', () => { if (!uploadBusy) { notify(''); loadDatasets(); } });
$('question-search').addEventListener('input', () => { clearTimeout(searchTimer); selection.reset(); selection.setLoading(true); currentPage = 1; searchTimer = setTimeout(loadQuestions, 250); });
for (const id of ['issue-filter', 'status-filter', 'advice-filter', 'page-size', ...(expertMode ? ['expert-status-filter'] : [])]) $(id).addEventListener('change', () => { clearTimeout(searchTimer); if (id !== 'page-size') selection.reset(); currentPage = 1; loadQuestions(); });
$('previous-page').addEventListener('click', () => { if (!pageBusy && currentPage > 1) { currentPage -= 1; loadQuestions(); } });
$('next-page').addEventListener('click', () => { if (!pageBusy && currentPage < totalPages) { currentPage += 1; loadQuestions(); } });
$('close-question').addEventListener('click', closeDetail);
$('question-detail').addEventListener('cancel', event => { event.preventDefault(); closeDetail(); });
$('previous-question').addEventListener('click', () => { if (!detailBusy && detailNavigation.previous) openQuestion(detailNavigation.previous); });
$('next-question').addEventListener('click', () => { if (!detailBusy && detailNavigation.next) openQuestion(detailNavigation.next); });
for (const name of ['fields', 'json']) {
  $(name + '-tab').addEventListener('click', () => switchDetailTab(name));
  $(name + '-tab').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); switchDetailTab(event.key === 'Home' ? 'fields' : event.key === 'End' ? 'json' : name === 'fields' ? 'json' : 'fields', true); } });
}
$('copy-question-json').addEventListener('click', async () => {
  if (!detailRecord) return;
  try { await navigator.clipboard.writeText(JSON.stringify(detailRecord, null, 2)); $('copy-question-json').textContent = '已复制'; setTimeout(() => { $('copy-question-json').textContent = '复制 JSON'; }, 2000); }
  catch { switchDetailTab('json'); $('question-json').focus(); $('question-json').select(); $('copy-question-json').textContent = '已选中，请按 Ctrl+C'; }
});
if (expertMode) expertActions = initExpertActions({
  getSelection: () => selection.context(), notify,
  onBusy(value) {
    for (const id of ['dataset-select', 'delete-dataset', 'configure-review-fields', 'question-search', 'issue-filter', 'status-filter', 'advice-filter', 'expert-status-filter', 'page-size', 'upload-dataset', 'choose-dataset', 'upload-first-dataset', 'dataset-input', 'refresh-datasets']) $(id).disabled = value || uploadBusy || deleteDatasetBusy;
    $('previous-page').disabled = value || pageBusy || currentPage <= 1; $('next-page').disabled = value || pageBusy || currentPage >= totalPages;
    selection.setLoading(value || pageBusy || uploadBusy);
  },
  async onChanged(data) {
    selection.reset(); updateDatasetStats(data.dataset);
    if (data.summary && detailData?.summary.number === data.summary.number) {
      detailData = data; detailRecord = data.record; detailNavigation = data.navigation;
      const meta = ['技术审核状态：' + (data.summary.status === 'approved' ? '已通过' : '待审核')];
      $('detail-meta').replaceChildren(...meta.map(text => node('span', '', text)));
      updateApprovalInfo(data.summary);
    }
    await loadQuestions();
  }
});
else initReviewActions({
  getCurrent: () => detailData,
  getSelection: () => selection.context(),
  notify,
  onChanged: async (data, action) => {
    selection.reset();
    updateDatasetStats(data.dataset);
    const previousFilters = getQuestionFilters();
    updateFilters();
    for (const name of ['status', 'advice', 'issue']) {
      const value = previousFilters[name === 'issue' ? 'issues' : name];
      if ([...$(name + '-filter').options].some(option => option.value === value)) $(name + '-filter').value = value;
    }
    $('question-search').value = previousFilters.query;
    if (action === 'edit') await openQuestion(data.summary.number); else closeDetail();
    await loadQuestions();
  }
});
async function refreshVisibleDataset() {
  if (!activeDataset || uploadBusy || deleteDatasetBusy || pageBusy || expertActions?.busy() || fieldTools.isOpen() || $('delete-dataset-dialog').open) return;
  if (!$('question-detail').open) {
    const version = ++datasetsVersion; const id = activeDataset.id;
    try {
      const data = await responseData(await fetch(reviewApi, { signal: AbortSignal.timeout(10000) }));
      if (version !== datasetsVersion || activeDataset?.id !== id) return;
      datasets = data.datasets; updateDatasetSelect();
      if (!datasets.some(dataset => dataset.id === id)) { await activateDataset(datasets[0] || null); notify('原评测集已在其他页面删除，列表已刷新。'); }
      else await loadQuestions();
    } catch (error) { notify(errorMessage(error), 'error'); }
  }
  else if (!expertMode && detailData && !['question-editor', 'delete-question-dialog', 'approve-question-dialog'].some(id => $(id).open)) openQuestion(detailData.summary.number);
}
globalThis.addEventListener?.('focus', refreshVisibleDataset);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshVisibleDataset(); });
loadDatasets();
