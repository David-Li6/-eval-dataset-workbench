import { node, renderRecord } from './review-render.js';
const $ = id => document.getElementById(id);
const labels = { queued: '排队中', preparing: '读取源文档', running: '生成中', completed: '生成完成', failed: '生成失败', cancelled: '已停止', interrupted: '任务已中断' };
const activeStates = ['queued', 'preparing', 'running'];
let jobs = [], loading = false, timer, resultJob, page = 1, totalPages = 1, resultSequence = 0, detailSequence = 0, resultController, detailController, searchTimer, record = null, navigation = {}, noticeTimer;
let deleteTarget = null, deleteBusy = false, listSequence = 0;
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
function notice(text, kind = '') { clearTimeout(noticeTimer); $('generated-notice').textContent = text; $('generated-notice').className = 'notice ' + kind; $('generated-notice').hidden = !text; }
async function request(route, body, method = body ? 'POST' : 'GET') {
  const response = await fetch(route, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); if (!response.ok) { const error = new Error(data.error?.message || '请求失败，请重试。'); error.code = data.error?.code; throw error; } return data;
}
function action(label, callback, className = '') { const button = node('button', className, label); button.type = 'button'; button.addEventListener('click', async () => { button.disabled = true; try { await callback(); } catch (error) { notice(error.message || '操作失败。', 'error'); } finally { button.disabled = false; } }); return button; }
function link(label, href) { const anchor = node('a', '', label); anchor.href = href; return anchor; }
async function jobAction(job, command) {
  const data = await request('/api/generations/' + job.id + '/' + command, {});
  if (command === 'review') {
    if (!data.dataset?.id) throw new Error('送审结果未返回评测集编号，请刷新列表后重试。');
    job.reviewDatasetId = data.dataset.id; renderJobs();
    notice('已送入审核，正在打开字段配置。', 'success');
    location.assign('/expert-review?' + new URLSearchParams({ dataset: data.dataset.id, configureFields: '1' }));
    return data;
  }
  notice(command === 'resume' ? '已继续生成剩余题目。' : '已停止生成，已完成的题目保留。', 'success');
  await loadJobs(); return data;
}
function renderJobs() {
  const query = $('generated-search').value.trim().toLowerCase(), status = $('generated-status').value;
  const visible = jobs.filter(job => (!query || [job.name, job.model, ...job.sources.map(file => file.name)].join('\n').toLowerCase().includes(query)) && (!status || (status === 'active' ? activeStates.includes(job.status) : status === 'completed' ? job.status === 'completed' : !activeStates.includes(job.status) && job.status !== 'completed')));
  $('generated-count').textContent = visible.length; $('generated-summary').textContent = jobs.filter(job => job.status === 'completed').length + ' 个 JSON 已完成 · ' + jobs.filter(job => activeStates.includes(job.status)).length + ' 个任务进行中';
  $('generated-empty').hidden = !!visible.length; $('generated-empty').textContent = jobs.length ? '没有匹配的生成任务，请调整搜索或筛选。' : '还没有生成任务，请到原始源文档页勾选文件，点击“AI 生成评测集”。';
  $('generated-rows').replaceChildren(...visible.map(job => {
    const row = node('tr', new URLSearchParams(location.search).get('job') === job.id ? 'generated-target' : '');
    row.setAttribute('data-job-id', job.id);
    const name = node('td'); name.append(node('div', 'generated-name', job.name + '.json'));
    const sources = node('td'); sources.append(node('div', 'generated-source-names', job.sources.map(file => file.name).join('、')));
    const model = node('td'); const modelLabel = node('div', 'generated-model', job.model); modelLabel.append(node('small', '', job.provider.name)); model.append(modelLabel);
    const state = node('td'); state.append(node('span', 'generation-state ' + job.status, labels[job.status] || job.status), node('span', 'generated-progress-label', job.completedCount + ' / ' + job.count + ' 题' + (job.batchCount && job.status !== 'completed' ? ' · 第 ' + (job.currentBatch || 0) + ' / ' + job.batchCount + ' 批' : '')));
    const progress = node('div', 'generated-progress-track'), fill = node('div'); fill.style.width = Math.min(100, job.completedCount / job.count * 100) + '%'; progress.append(fill); state.append(progress);
    if (job.sourceSampled) state.append(node('div', 'generated-sampling', '从 ' + job.sourceUnitCount + ' 段资料中抽选 ' + job.selectedSourceUnitCount + ' 段，按设置生成 ' + job.count + ' 题。'));
    if (job.error) state.append(node('div', 'generated-error', job.error));
    const actions = node('td'), group = node('div', 'generated-actions');
    if (job.completedCount) group.append(action('查看题目', () => openResult(job)));
    if (job.status === 'completed') {
      group.append(link('下载 JSON', '/api/generations/' + job.id + '/download'));
      if (job.reviewDatasetId) group.append(link('业务专家审核', '/expert-review?dataset=' + job.reviewDatasetId), link('技术人员审核', '/technical-review?dataset=' + job.reviewDatasetId));
      else group.append(action('送入审核', () => jobAction(job, 'review')));
    } else {
      if (job.completedCount) group.append(link('下载已生成部分', '/api/generations/' + job.id + '/partial'));
      if (activeStates.includes(job.status)) group.append(action('停止生成', () => jobAction(job, 'cancel'), 'stop'));
      else group.append(action('继续生成', () => jobAction(job, 'resume')));
    }
    const remove = action('删除任务', () => openDeleteTask(job), 'delete-task');
    remove.setAttribute('aria-label', '删除任务：' + job.name);
    remove.disabled = deleteBusy;
    group.append(remove);
    actions.append(group); row.append(name, sources, model, state, node('td', '', dateLabel(job.createdAt)), actions); return row;
  }));
}
function schedule() { clearTimeout(timer); if (jobs.some(job => activeStates.includes(job.status))) timer = setTimeout(() => { if (!document.hidden) loadJobs(); else schedule(); }, 2000); }
async function loadJobs(force = false) {
  if (deleteBusy || loading && !force) return;
  const sequence = ++listSequence; loading = true; $('refresh-generated').disabled = true;
  try { const data = await request('/api/generations'); if (sequence !== listSequence) return; jobs = data.jobs; renderJobs(); }
  catch (error) { if (sequence === listSequence) notice(error.message || '无法读取生成任务。', 'error'); }
  finally { if (sequence === listSequence) { loading = false; $('generated-loading').hidden = true; $('refresh-generated').disabled = false; schedule(); } }
}
function openDeleteTask(job) {
  if (deleteBusy) return;
  deleteTarget = job;
  $('delete-task-name').textContent = job.name + '.json';
  $('delete-task-meta').textContent = (labels[job.status] || job.status) + ' · ' + job.completedCount + ' / ' + job.count + ' 题 · 创建于 ' + dateLabel(job.createdAt);
  $('delete-task-active').hidden = !activeStates.includes(job.status);
  $('delete-task-error').hidden = true;
  $('delete-task-dialog').showModal();
}
function closeDeleteTask() { if (!deleteBusy) { $('delete-task-dialog').close(); deleteTarget = null; } }
async function confirmDeleteTask() {
  if (!deleteTarget || deleteBusy) return;
  const job = deleteTarget;
  deleteBusy = true; listSequence += 1; loading = false; clearTimeout(timer);
  $('refresh-generated').disabled = true;
  $('delete-task-error').hidden = true;
  $('cancel-delete-task').disabled = $('confirm-delete-task').disabled = true;
  $('confirm-delete-task').textContent = '正在删除…';
  $('delete-task-dialog').setAttribute('aria-busy', 'true');
  try {
    try { await request('/api/generations/' + job.id, {}, 'DELETE'); }
    catch (error) { if (error.code !== 'GENERATION_NOT_FOUND') throw error; }
    jobs = jobs.filter(item => item.id !== job.id);
    if (resultJob?.id === job.id) closeResult();
    $('delete-task-dialog').close(); deleteTarget = null;
    renderJobs();
    notice('已删除任务“' + job.name + '”。原始源文档、审核内容和冻结版本保留。', 'success');
  } catch (error) {
    $('delete-task-error').textContent = error.name === 'TimeoutError' ? '删除请求超时，请重试或刷新列表确认结果。' : error.message || '删除失败，请稍后重试。';
    $('delete-task-error').hidden = false;
  } finally {
    deleteBusy = false;
    $('cancel-delete-task').disabled = $('confirm-delete-task').disabled = false;
    $('confirm-delete-task').textContent = '确认删除';
    $('delete-task-dialog').setAttribute('aria-busy', 'false');
    renderJobs();
    await loadJobs(true);
  }
}
async function openResult(job) {
  resultJob = job; page = 1; $('generated-question-search').value = '';
  $('generated-result-title').textContent = job.name + '.json'; $('generated-result-description').textContent = job.completedCount + ' / ' + job.count + ' 题 · ' + (labels[job.status] || job.status) + ' · AI 生成内容待审核';
  $('generated-result-meta').replaceChildren(...['模型：' + job.model, '模板：' + job.templateName, '源文件：' + job.sources.map(file => file.name).join('、')].map(text => node('span', '', text)));
  if (job.sourceSampled) $('generated-result-meta').append(node('span', '', '资料抽选：' + job.selectedSourceUnitCount + ' / ' + job.sourceUnitCount + ' 段，不代表覆盖全部原题'));
  $('generated-source-refs').textContent = '正在读取引用索引...'; $('generated-prompt').value = '';
  if (!$('generated-result').open) $('generated-result').showModal();
  const task = loadQuestions();
  try { const data = await request('/api/generations/' + job.id); if (resultJob?.id === job.id) { $('generated-source-refs').textContent = (data.job.sourceRefs || []).map(ref => '[' + ref.ref + '] ' + ref.fileName + ' · ' + ref.location + (ref.originalId ? ' · 原题 ID：' + ref.originalId : '')).join('\n'); $('generated-prompt').value = data.job.prompt; } }
  catch (error) { $('generated-source-refs').textContent = error.message; }
  await task;
}
async function loadQuestions() {
  if (!resultJob) return; resultController?.abort(); resultController = new AbortController(); const sequence = ++resultSequence;
  $('generated-question-rows').replaceChildren(); $('generated-question-message').hidden = false; $('generated-question-message').textContent = '正在读取题目...'; $('generated-question-prev-page').disabled = $('generated-question-next-page').disabled = true;
  try {
    const response = await fetch('/api/generations/' + resultJob.id + '/questions?' + new URLSearchParams({ page: String(page), query: $('generated-question-search').value.trim() }), { signal: AbortSignal.any([resultController.signal, AbortSignal.timeout(15000)]) }); const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || '题目读取失败。'); if (sequence !== resultSequence) return;
    page = data.page; totalPages = data.totalPages;
    $('generated-question-rows').replaceChildren(...data.questions.map(item => {
      const row = node('tr'), question = node('td'); question.append(action(item.question, () => openQuestion(item.number), 'question-text'));
      const view = node('td'); view.append(action('查看详情', () => openQuestion(item.number), 'view-question'));
      row.append(node('td', 'question-number', String(item.number).padStart(3, '0')), question, node('td', '', item.difficulty), node('td', '', item.family), node('td', 'source-text', item.source), view); return row;
    }));
    $('generated-question-message').hidden = !!data.total; $('generated-question-message').textContent = '没有匹配的题目。'; $('generated-question-range').textContent = '共 ' + data.total + ' 题 · 当前 ' + (data.total ? (page - 1) * 20 + 1 : 0) + '–' + Math.min(page * 20, data.total); $('generated-question-page').textContent = page + ' / ' + totalPages;
  } catch (error) { if (sequence === resultSequence && error.name !== 'AbortError') { $('generated-question-message').hidden = false; $('generated-question-message').textContent = error.message; } }
  finally { if (sequence === resultSequence) { $('generated-question-prev-page').disabled = page <= 1; $('generated-question-next-page').disabled = page >= totalPages; } }
}
function tab(name, focus = false) { for (const key of ['fields', 'json']) { const selected = key === name; $('generated-' + key + '-tab').setAttribute('aria-selected', String(selected)); $('generated-' + key + '-tab').tabIndex = selected ? 0 : -1; $('generated-' + key + '-panel').hidden = !selected; } if (focus) $('generated-' + name + '-tab').focus(); }
async function openQuestion(number) {
  if (!resultJob) return; detailController?.abort(); detailController = new AbortController(); const sequence = ++detailSequence; record = null; navigation = {};
  $('generated-question-title').textContent = '第 ' + number + ' 题'; $('generated-question-dataset').textContent = resultJob.name; $('generated-fields-panel').replaceChildren(node('div', 'detail-loading', '正在读取完整题目...')); $('generated-question-json').value = ''; $('copy-generated-question').disabled = true; $('generated-question-prev').disabled = $('generated-question-next').disabled = true; tab('fields'); $('generated-fields-panel').scrollTop = 0;
  if (!$('generated-question-detail').open) $('generated-question-detail').showModal();
  try {
    const response = await fetch('/api/generations/' + resultJob.id + '/questions/' + number, { signal: AbortSignal.any([detailController.signal, AbortSignal.timeout(15000)]) }); const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '题目读取失败。'); if (sequence !== detailSequence) return;
    record = data.record; navigation = data.navigation; $('generated-fields-panel').replaceChildren(...renderRecord(record)); $('generated-question-json').value = JSON.stringify(record, null, 2); $('copy-generated-question').disabled = false; $('generated-question-position').textContent = '第 ' + number + ' / ' + navigation.total + ' 题'; $('generated-question-prev').disabled = !navigation.previous; $('generated-question-next').disabled = !navigation.next;
  } catch (error) { if (sequence === detailSequence && error.name !== 'AbortError') $('generated-fields-panel').replaceChildren(node('div', 'detail-loading', error.message)); }
}
function closeQuestion() { detailSequence += 1; detailController?.abort(); record = null; $('generated-question-detail').close(); }
function closeResult() { closeQuestion(); resultSequence += 1; resultController?.abort(); clearTimeout(searchTimer); resultJob = null; $('generated-result').close(); }
$('generated-search').addEventListener('input', renderJobs); $('generated-status').addEventListener('change', renderJobs); $('refresh-generated').addEventListener('click', () => loadJobs());
$('cancel-delete-task').addEventListener('click', closeDeleteTask); $('confirm-delete-task').addEventListener('click', confirmDeleteTask); $('delete-task-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDeleteTask(); });
$('close-generated-result').addEventListener('click', closeResult); $('generated-result').addEventListener('cancel', event => { event.preventDefault(); closeResult(); });
$('close-generated-question').addEventListener('click', closeQuestion); $('generated-question-detail').addEventListener('cancel', event => { event.preventDefault(); closeQuestion(); });
$('generated-question-search').addEventListener('input', () => { clearTimeout(searchTimer); page = 1; searchTimer = setTimeout(loadQuestions, 250); });
$('generated-question-prev-page').addEventListener('click', () => { if (page > 1) { page -= 1; loadQuestions(); } }); $('generated-question-next-page').addEventListener('click', () => { if (page < totalPages) { page += 1; loadQuestions(); } });
$('generated-question-prev').addEventListener('click', () => { if (navigation.previous) openQuestion(navigation.previous); }); $('generated-question-next').addEventListener('click', () => { if (navigation.next) openQuestion(navigation.next); });
for (const name of ['fields', 'json']) { $('generated-' + name + '-tab').addEventListener('click', () => tab(name)); $('generated-' + name + '-tab').addEventListener('keydown', event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); tab(event.key === 'Home' ? 'fields' : event.key === 'End' ? 'json' : name === 'fields' ? 'json' : 'fields', true); } }); }
$('copy-generated-question').addEventListener('click', async () => { if (!record) return; try { await navigator.clipboard.writeText(JSON.stringify(record, null, 2)); $('copy-generated-question').textContent = '已复制'; setTimeout(() => { $('copy-generated-question').textContent = '复制 JSON'; }, 2000); } catch { tab('json'); $('generated-question-json').focus(); $('generated-question-json').select(); } });
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadJobs(); });
loadJobs();
