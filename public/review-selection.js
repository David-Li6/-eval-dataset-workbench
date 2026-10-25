const $ = id => document.getElementById(id);

export function initQuestionSelection({ getDataset, getFilters, notify, endpoint = '/api/technical-reviews', actionIds = ['batch-delete-questions', 'batch-approve-questions'] }) {
  const selected = new Map(); const checkboxes = new Map();
  let pageItems = [], total = 0, loading = false, selecting = false, sequence = 0, controller;
  function update() {
    const selectedOnPage = pageItems.filter(item => selected.has(item.number)).length;
    $('selection-count').textContent = '已选择 ' + selected.size + ' 题';
    $('select-page-questions').checked = !!pageItems.length && selectedOnPage === pageItems.length;
    $('select-page-questions').indeterminate = selectedOnPage > 0 && selectedOnPage < pageItems.length;
    $('select-page-questions').disabled = loading || selecting || !pageItems.length;
    $('select-filtered-questions').textContent = selecting ? '正在选择全部题目...' : '全选当前筛选结果（' + total + ' 题）';
    $('select-filtered-questions').disabled = loading || selecting || !total;
    for (const id of ['clear-question-selection', ...actionIds]) $(id).disabled = loading || selecting || !selected.size;
    for (const [number, checkbox] of checkboxes) { checkbox.checked = selected.has(number); checkbox.disabled = loading || selecting; }
  }
  function reset() {
    sequence += 1; controller?.abort(); selecting = false; selected.clear(); update();
  }
  $('select-page-questions').addEventListener('change', () => {
    if (loading || selecting) return;
    for (const item of pageItems) { if ($('select-page-questions').checked) selected.set(item.number, item); else selected.delete(item.number); }
    update();
  });
  $('clear-question-selection').addEventListener('click', reset);
  $('select-filtered-questions').addEventListener('click', async () => {
    const dataset = getDataset(); if (!dataset || loading || selecting || !total) return;
    controller?.abort(); controller = new AbortController(); const current = ++sequence;
    selecting = true; update();
    try {
      const response = await fetch(endpoint + '/' + dataset.id + '/selection?' + new URLSearchParams(getFilters()), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message || '全选失败，请重试。');
      if (current !== sequence) return;
      selected.clear(); for (const item of data.questions) selected.set(item.number, item);
      total = data.questions.length;
    } catch (error) { if (current === sequence && error.name !== 'AbortError') notify(error.name === 'TimeoutError' ? '全选超时，请重试。' : error.message || '无法连接本地工具。', 'error'); }
    finally { if (current === sequence) { selecting = false; update(); } }
  });
  update();
  return {
    reset,
    setLoading(value) { loading = value; update(); },
    renderPage(items, count) {
      pageItems = items; total = count; checkboxes.clear();
      for (const item of items) if (selected.has(item.number)) {
        if (selected.get(item.number).revision !== item.revision) selected.delete(item.number); else selected.set(item.number, item);
      }
      update();
    },
    checkbox(item) {
      const input = document.createElement('input'); input.type = 'checkbox'; input.className = 'question-checkbox'; input.checked = selected.has(item.number);
      input.setAttribute('aria-label', '选择第 ' + item.number + ' 题');
      input.addEventListener('change', () => { if (loading || selecting) return; if (input.checked) selected.set(item.number, item); else selected.delete(item.number); update(); });
      checkboxes.set(item.number, input); return input;
    },
    context() { return selected.size ? { dataset: getDataset(), summaries: [...selected.values()].sort((a, b) => a.number - b.number) } : null; }
  };
}
