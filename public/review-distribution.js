import { node } from './review-render.js';
const $ = id => document.getElementById(id);
const typeNames = { number: '数值', boolean: '布尔值', null: 'null', array: '数组', object: '对象' };
const categoryLabel = category => category.label + (category.truncated ? '…' : '') + (typeNames[category.type] ? ' · ' + typeNames[category.type] : '');
const percent = value => value.toFixed(1) + '%';

export function initReviewDistribution({ endpoint, getDataset, getFilters }) {
  let datasetId = null, enabled = [], first = null, second = null, data = null, signature = null;
  let sequence = 0, controller, rowPage = 0, columnPage = 0;
  function status(text = '', error = false) {
    $('distribution-message').textContent = text; $('distribution-message').hidden = !text;
    $('distribution-message').className = 'distribution-message' + (error ? ' error' : '');
  }
  function cancel() { sequence++; controller?.abort(); $('distribution-loading').hidden = true; }
  function controls() {
    const options = (omit, placeholder) => [new Option(placeholder, ''), ...enabled.flatMap((field, index) => field.key === omit ? [] : [new Option(field.key || '""', String(index + 1))])];
    $('distribution-first').replaceChildren(...options(null, '选择一个分类字段'));
    $('distribution-second').replaceChildren(...options(first, '不选择（条形图）'));
    $('distribution-first').value = first === null ? '' : String(enabled.findIndex(field => field.key === first) + 1);
    $('distribution-second').value = second === null ? '' : String(enabled.findIndex(field => field.key === second) + 1);
    $('distribution-first').disabled = !enabled.length;
    $('distribution-second').disabled = first === null || enabled.length < 2;
  }
  function pagination(parent, name, page, totalPages, change) {
    const wrapper = node('div', 'distribution-pagination'); wrapper.append(node('span', '', name + ' ' + (page + 1) + ' / ' + totalPages));
    for (const [label, step, disabled] of [['上一页', -1, page === 0], ['下一页', 1, page >= totalPages - 1]]) {
      const button = node('button', 'button', label); button.type = 'button'; button.disabled = disabled; button.setAttribute('aria-label', name + label);
      button.addEventListener('click', () => change(page + step)); wrapper.append(button);
    }
    parent.append(wrapper);
  }
  function render() {
    $('distribution-result').replaceChildren(); if (!data) return;
    const chart = node('article', 'distribution-chart'), heading = node('header');
    const title = data.fields.length === 1 ? (data.fields[0] || '""') + '题量分布' : data.fields.map(key => key || '""').join(' × ') + '题量分布矩阵';
    heading.append(node('h3', '', title), node('span', 'distribution-sample', '总样本 n=' + data.total)); chart.append(heading);
    chart.append(node('p', 'distribution-scope-note', $('distribution-scope').value === 'all' ? '范围：当前评测集全部保留题目' : '范围：当前筛选结果，覆盖全部页'));
    if (!data.total) chart.append(node('p', 'distribution-empty', '当前范围没有题目，可调整搜索、筛选条件或统计范围。'));
    else if (data.fields.length === 1) renderBars(chart);
    else renderMatrix(chart);
    $('distribution-result').append(chart);
  }
  function renderBars(chart) {
    const categories = data.axes[0].categories, pages = Math.max(1, Math.ceil(categories.length / 20)); rowPage = Math.min(rowPage, pages - 1);
    const max = Math.max(...categories.map(category => category.count)), list = node('div', 'distribution-bars');
    for (const category of categories.slice(rowPage * 20, (rowPage + 1) * 20)) {
      const row = node('div', 'distribution-bar-row'); row.setAttribute('aria-label', categoryLabel(category) + '：' + category.count + '题，占' + percent(category.percentage));
      const label = node('span', 'distribution-category', categoryLabel(category)); label.title = categoryLabel(category);
      const track = node('div', 'distribution-bar-track'), fill = node('div', 'distribution-bar-fill'); fill.style.width = category.count / max * 100 + '%'; track.append(fill);
      row.append(label, track, node('strong', 'distribution-count', category.count + '题'), node('span', 'distribution-percent', percent(category.percentage))); list.append(row);
    }
    chart.append(list, node('p', 'distribution-footnote', '条长按题数线性缩放，最大类别为满格；百分比以 ' + data.total + ' 题为分母。共 ' + categories.length + ' 个分类。'));
    if (pages > 1) pagination(chart, '分类', rowPage, pages, page => { rowPage = page; render(); });
  }
  function renderMatrix(chart) {
    const rows = data.axes[0].categories, columns = data.axes[1].categories;
    const rowPages = Math.max(1, Math.ceil(rows.length / 20)), columnPages = Math.max(1, Math.ceil(columns.length / 10));
    rowPage = Math.min(rowPage, rowPages - 1); columnPage = Math.min(columnPage, columnPages - 1);
    const visibleRows = rows.slice(rowPage * 20, (rowPage + 1) * 20), visibleColumns = columns.slice(columnPage * 10, (columnPage + 1) * 10);
    const values = new Map(data.cells.map(cell => [cell.row + ':' + cell.column, cell]));
    const max = Math.max(...data.cells.map(cell => cell.count));
    const wrap = node('div', 'distribution-matrix-wrap'), table = node('table', 'distribution-matrix'); table.setAttribute('aria-label', data.fields.join(' × ') + '交叉分布矩阵');
    const thead = node('thead'), head = node('tr');
    head.append(node('th', '', (data.fields[0] || '""') + ' \\ ' + (data.fields[1] || '""')));
    for (const category of visibleColumns) { const th = node('th', '', categoryLabel(category)); th.setAttribute('scope', 'col'); th.title = categoryLabel(category); head.append(th); }
    const totalHead = node('th', 'distribution-total', '行合计'); totalHead.setAttribute('scope', 'col'); head.append(totalHead); thead.append(head);
    const body = node('tbody');
    for (const rowCategory of visibleRows) {
      const tr = node('tr'), th = node('th', '', categoryLabel(rowCategory)); th.setAttribute('scope', 'row'); th.title = categoryLabel(rowCategory); tr.append(th);
      for (const columnCategory of visibleColumns) {
        const cell = values.get(rowCategory.value + ':' + columnCategory.value), count = cell?.count || 0;
        const td = node('td', 'distribution-matrix-cell'); td.append(node('strong', '', count + '题'), node('small', '', percent(cell?.percentage || 0)));
        td.title = categoryLabel(rowCategory) + ' × ' + categoryLabel(columnCategory) + '：' + count + '题';
        if (count) { const intensity = count / max; td.style.backgroundColor = 'rgba(50,127,174,' + (0.08 + 0.82 * intensity) + ')'; if (intensity > 0.65) td.style.color = '#fff'; }
        tr.append(td);
      }
      const total = node('td', 'distribution-total', rowCategory.count + '题'); total.title = '该行在全部列分类中的题数'; tr.append(total); body.append(tr);
    }
    const foot = node('tfoot'), totals = node('tr'); totals.append(node('th', '', '列合计'));
    for (const category of visibleColumns) { const td = node('td', 'distribution-total', category.count + '题'); td.title = '该列在全部行分类中的题数'; totals.append(td); }
    totals.append(node('td', 'distribution-grand-total', '总计 ' + data.total + '题')); foot.append(totals); table.append(thead, body, foot); wrap.append(table); chart.append(wrap);
    chart.append(node('p', 'distribution-footnote', '单元格占比以 ' + data.total + ' 题为分母；行、列合计覆盖对应分类的全部题目。共 ' + rows.length + ' 个行分类、' + columns.length + ' 个列分类。'));
    if (rowPages > 1) pagination(chart, '行分类', rowPage, rowPages, page => { rowPage = page; render(); });
    if (columnPages > 1) pagination(chart, '列分类', columnPage, columnPages, page => { columnPage = page; render(); });
  }
  async function refresh() {
    const dataset = getDataset();
    if (!dataset || first === null) { cancel(); data = null; signature = null; render(); status(enabled.length ? '选择一个字段查看条形图，选择两个字段查看交叉分布矩阵。' : '暂无可统计字段，请先在审核页的“字段配置”中启用分类筛选。'); return; }
    const fields = second === null ? [first] : [first, second], filters = $('distribution-scope').value === 'all' ? {} : getFilters();
    const current = JSON.stringify([dataset.id, dataset.revision, dataset.fieldSettingsRevision, fields, filters, $('distribution-scope').value]);
    if (signature === current) return;
    cancel(); signature = current; const requestSequence = sequence; controller = new AbortController(); data = null; render(); status(); $('distribution-loading').hidden = false;
    try {
      const response = await fetch(endpoint + '/' + dataset.id + '/distribution?' + new URLSearchParams({ ...filters, fields: JSON.stringify(fields) }), { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]) });
      const result = await response.json(); if (requestSequence !== sequence) return;
      if (!response.ok) throw new Error(result.error?.message || '分布统计失败，请重试。');
      data = result; rowPage = columnPage = 0; render();
    } catch (error) {
      if (requestSequence === sequence && error.name !== 'AbortError') { signature = null; status(error.name === 'TimeoutError' ? '分布统计超时，请重新选择字段或刷新页面。' : error.message || '分布统计失败，请重试。', true); }
    } finally { if (requestSequence === sequence) $('distribution-loading').hidden = true; }
  }
  function choose(id) { const value = $(id).value; return value ? enabled[Number(value) - 1]?.key ?? null : null; }
  $('distribution-first').addEventListener('change', async () => { first = choose('distribution-first'); if (first === null || first === second) second = null; controls(); await refresh(); });
  $('distribution-second').addEventListener('change', async () => { second = choose('distribution-second'); await refresh(); });
  $('distribution-scope').addEventListener('change', refresh);
  return {
    reset() { cancel(); datasetId = null; enabled = []; first = second = data = signature = null; controls(); render(); status(); },
    update(dataset) {
      if (dataset?.id !== datasetId) { cancel(); first = second = data = signature = null; datasetId = dataset?.id || null; }
      enabled = (dataset?.fieldSettings || []).filter(field => field.filterable);
      if (!enabled.some(field => field.key === first)) first = null;
      if (first === null || !enabled.some(field => field.key === second)) second = null;
      controls(); return refresh();
    }
  };
}
