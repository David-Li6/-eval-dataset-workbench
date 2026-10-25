import { node } from './review-render.js';
const $ = id => document.getElementById(id);
const key = context => context.dataset.id + ':' + context.summary.number;
const route = context => '/api/expert-reviews/' + context.dataset.id + '/questions/' + context.summary.number;
const dateLabel = value => new Date(value).toLocaleString('zh-CN', { hour12: false });
const message = error => error.name === 'TimeoutError' ? '操作超时，请刷新确认结果后再试。' : error instanceof TypeError ? '无法连接本地工具，请确认服务正在运行。' : error.message;
async function request(url, method, body) {
  const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '操作失败，请重试。'); return data;
}

export function initExpertActions({ getSelection, onChanged, onBusy, notify }) {
  let context = null, busy = false;
  const unsaved = new Map();
  const error = text => { $('expert-review-error').textContent = text; $('expert-review-error').hidden = !text; };
  const value = () => $('expert-advice-text').value.trim();
  function needsSave() { return !context?.expertReview.draft || context.expertReview.draft.text !== value() || context.expertReview.draft.questionRevision !== context.summary.revision; }
  function update() {
    const text = value(); const review = context?.expertReview;
    const changed = !!context && (text !== (review.draft?.text || review.submitted?.text || '') || !!review.draft && review.draft.questionRevision !== context.summary.revision || !!review.submitted && !review.submitted.isCurrent);
    $('expert-advice-count').textContent = $('expert-advice-text').value.length.toLocaleString('en-US') + ' / 20,000';
    $('expert-advice-text').disabled = busy || !context;
    $('save-expert-draft').disabled = busy || !context || !text || (!changed && !review?.draft && !!review?.submitted);
    $('submit-expert-advice').disabled = busy || !context || !text || (!changed && !review?.draft && !!review?.submitted);
    $('close-question').disabled = busy;
    $('previous-question').disabled = busy || !context?.navigation.previous; $('next-question').disabled = busy || !context?.navigation.next;
    $('expert-draft-status').textContent = busy ? '正在保存或提交，请稍候...' : !context ? '' : unsaved.has(key(context)) ? '有未保存的修改，提交时会一并保存。' : review.draft ? (review.draft.questionRevision !== context.summary.revision ? '题目已修改，请核对后重新保存或提交建议。' : '草稿已保存 · ' + dateLabel(review.draft.updatedAt)) : review.submitted ? (review.submitted.isCurrent ? '已提交给技术人员 · ' + dateLabel(review.submitted.submittedAt) : '题目在建议提交后已修改，可重新核对并提交。') : '尚未填写建议。保存草稿不会提交给技术人员。';
  }
  function render(data) {
    context = data;
    $('expert-advice-text').value = unsaved.get(key(data))?.text ?? data.expertReview.draft?.text ?? data.expertReview.submitted?.text ?? '';
    $('expert-open-technical').href = '/technical-review?dataset=' + encodeURIComponent(data.dataset.id) + '&question=' + data.summary.number;
    $('expert-advice-history').replaceChildren(...data.expertReview.history.map((entry, index) => {
      const details = node('details', 'expert-advice-history'); details.append(node('summary', '', (index ? '历史提交 · ' : '最近提交 · ') + dateLabel(entry.submittedAt)), node('pre', 'field-string', entry.text)); return details;
    }));
    update();
  }
  function setBusy(value) { busy = value; onBusy(value); update(); }
  async function saveDraft() {
    const result = await request(route(context) + '/advice', 'PUT', { text: value(), questionRevision: context.summary.revision, expertRevision: context.expertReview.revision });
    unsaved.delete(key(context)); render(result); await onChanged(result, 'draft'); return result;
  }
  $('expert-advice-text').addEventListener('input', () => {
    if (!context) return;
    const base = context.expertReview.draft?.text ?? context.expertReview.submitted?.text ?? '';
    if (value() === base) unsaved.delete(key(context)); else unsaved.set(key(context), { text: $('expert-advice-text').value });
    error(''); update();
  });
  $('save-expert-draft').addEventListener('click', async () => {
    if (busy || !context || !value()) return;
    setBusy(true); error('');
    try { await saveDraft(); notify('专家建议草稿已保存，提交后技术人员可见。', 'success'); }
    catch (err) { error(message(err)); }
    finally { setBusy(false); }
  });
  $('submit-expert-advice').addEventListener('click', async () => {
    if (busy || !context || !value()) return;
    setBusy(true); error('');
    try {
      if (needsSave()) await saveDraft();
      const result = await request(route(context) + '/submit', 'POST', { questionRevision: context.summary.revision, expertRevision: context.expertReview.revision });
      unsaved.delete(key(context)); render(result); await onChanged(result, 'submit'); notify('第 ' + result.summary.number + ' 题的专家建议已提交，技术人员可在待审核题目中查看。', 'success');
    } catch (err) { error(message(err)); }
    finally { setBusy(false); }
  });
  $('batch-submit-expert').addEventListener('click', async () => {
    const selected = getSelection(); if (busy || !selected) return;
    const incomplete = selected.summaries.find(item => item.expertStatus !== 'draft' || item.draftOutdated || unsaved.has(selected.dataset.id + ':' + item.number));
    if (incomplete) { notify('第 ' + incomplete.number + ' 题没有可提交的最新建议草稿，请先打开题目核对并保存，或取消勾选。', 'error'); return; }
    setBusy(true);
    try {
      const result = await request('/api/expert-reviews/' + selected.dataset.id + '/submit', 'POST', { questions: selected.summaries.map(({ number, revision, expertRevision }) => ({ number, revision, expertRevision })) });
      await onChanged(result, 'batch-submit'); notify('已将 ' + result.affectedCount + ' 道题的专家建议提交给技术人员。', 'success');
    } catch (err) { notify(message(err), 'error'); }
    finally { setBusy(false); }
  });
  return {
    busy: () => busy,
    load(data) { error(''); render(data); },
    clear() { context = null; $('expert-advice-text').value = ''; $('expert-advice-history').replaceChildren(); error(''); update(); }
  };
}
