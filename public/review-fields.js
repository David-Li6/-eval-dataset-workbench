import { node } from './review-render.js';
const $ = id => document.getElementById(id);
const typeLabels = { string: '文本', number: '数值', boolean: '布尔值', null: 'null', array: '数组', object: '对象', missing: '字段缺失' };

export function initReviewFields({ endpoint, getDataset, isBusy, onFilterChanged, onSaved, notify, readOnly = false }) {
  const filters = new Map(), inputs = new Map();
  const facetSelected = new Map(), facetBoxes = new Map();
  let facetLoading = false;
  let datasetId = null, configTarget = null, configRevision = 'none', configBusy = false, configSequence = 0;
  let facetKey = null, facetSequence = 0, facetController, facetTimer, facetPage = 1, facetPages = 1, facetOptions = [];
  async function request(route, options = {}) {
    const response = await fetch(route, { ...options, signal: options.signal || AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error?.message || '字段设置读取失败，请重试。'), { code: data.error?.code });
    return data;
  }
  function showError(id, text = '') { $(id).textContent = text; $(id).hidden = !text; }
  function chips() {
    $('review-field-chips').replaceChildren(...[...filters].map(([key, options]) => {
      const label = options.map(option => option.label).join('、');
      const button = node('button', 'field-filter-chip', key + '：' + label.slice(0, 45) + (options.length > 1 ? '（' + options.length + '类）' : '') + ' ×'); button.type = 'button'; button.title = label;
      button.setAttribute('aria-label', '清除字段筛选：' + key);
      button.addEventListener('click', async () => { filters.delete(key); chips(); await onFilterChanged(); });
      return button;
    }));
    if (filters.size) {
      const clear = node('button', 'clear-field-filters', '清除全部字段筛选'); clear.type = 'button';
      clear.addEventListener('click', async () => { filters.clear(); chips(); await onFilterChanged(); }); $('review-field-chips').append(clear);
    }
    $('review-field-chips').hidden = !filters.size;
  }
  function update(dataset) {
    if (dataset?.id !== datasetId) { filters.clear(); datasetId = dataset?.id || null; }
    const enabled = new Set((dataset?.fieldSettings || []).filter(field => field.filterable).map(field => field.key));
    for (const key of filters.keys()) if (!enabled.has(key)) filters.delete(key);
    chips();
  }
  function configControls(busy) {
    $('review-fields-fieldset').disabled = busy;
    for (const id of ['save-review-fields', 'cancel-review-fields', 'close-review-fields']) $(id).disabled = busy;
  }
  function closeConfig() { if (!readOnly && !configBusy) { configSequence += 1; $('review-fields-dialog').close(); configTarget = null; } }
  async function openConfig() {
    const dataset = getDataset(); if (readOnly || !dataset || isBusy() || configBusy) return;
    const sequence = ++configSequence; configTarget = dataset.id; inputs.clear();
    $('review-fields-dataset').textContent = dataset.name; $('review-fields-search').value = ''; $('review-fields-rows').replaceChildren();
    $('review-fields-loading').textContent = '正在识别 JSON key…'; $('review-fields-loading').hidden = false; showError('review-fields-error'); configControls(true);
    $('review-fields-dialog').showModal();
    try {
      const data = await request(endpoint + '/' + dataset.id + '/fields');
      if (sequence !== configSequence || getDataset()?.id !== dataset.id) return;
      configRevision = data.revision;
      $('review-fields-rows').replaceChildren(...data.fields.map(field => {
        const row = node('tr'); const key = node('td'); key.append(node('code', '', field.key || '""'));
        const info = node('td', 'review-field-info', field.types.map(type => typeLabels[type] || type).join('、') || '暂无值');
        info.append(node('small', '', field.categoryCount + ' 类值' + (field.missingCount ? ' · ' + field.missingCount + ' 题缺少字段' : '')));
        const description = node('textarea'); description.value = field.description; description.rows = 2; description.maxLength = 2000; description.placeholder = '填写这个字段的含义'; description.setAttribute('aria-label', '字段描述：' + field.key);
        const descriptionCell = node('td'); descriptionCell.append(description);
        const check = node('input'); check.type = 'checkbox'; check.checked = field.filterable; check.setAttribute('aria-label', '启用分类筛选：' + field.key);
        const label = node('label', 'review-field-toggle'); label.append(check, node('span', '', '启用')); const filterCell = node('td'); filterCell.append(label);
        row.append(key, info, descriptionCell, filterCell); inputs.set(field.key, { description, check, row }); return row;
      }));
      $('review-fields-loading').hidden = true;
    } catch (error) { if (sequence === configSequence) { showError('review-fields-error', error.message || '字段读取失败。'); $('review-fields-loading').hidden = true; } }
    finally { if (sequence === configSequence) { configControls(false); $('save-review-fields').disabled = !inputs.size; } }
  }
  if (!readOnly) {
    $('configure-review-fields').addEventListener('click', openConfig);
    for (const id of ['cancel-review-fields', 'close-review-fields']) $(id).addEventListener('click', closeConfig);
    $('review-fields-dialog').addEventListener('cancel', event => { event.preventDefault(); closeConfig(); });
    $('review-fields-search').addEventListener('input', () => { const query = $('review-fields-search').value.trim().toLowerCase(); for (const [key, field] of inputs) field.row.hidden = !!query && ![key, field.description.value].join('\n').toLowerCase().includes(query); });
    $('review-fields-form').addEventListener('submit', async event => {
      event.preventDefault(); if (!configTarget || configBusy || !inputs.size) return;
      configBusy = true; configControls(true); showError('review-fields-error');
      try {
        const fields = [...inputs].map(([key, field]) => ({ key, description: field.description.value, filterable: field.check.checked }));
        const data = await request(endpoint + '/' + configTarget + '/fields', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: configRevision, fields }) });
        $('review-fields-dialog').close(); configTarget = null; update(data.dataset); await onSaved(data.dataset);
        notify('字段配置已保存，审核页和相关冻结版本共用。点击启用筛选的表头可选择分类。', 'success');
      } catch (error) { showError('review-fields-error', error.message || '保存字段配置失败，请重试。'); }
      finally { configBusy = false; configControls(false); }
    });
  }
  function facetSelectionState() {
    $('review-field-selected-count').textContent = '已选择 ' + facetSelected.size + ' 个分类';
    const selectedOnPage = facetOptions.filter(option => facetSelected.has(option.value)).length;
    $('select-review-field-page').checked = !!facetOptions.length && selectedOnPage === facetOptions.length;
    $('select-review-field-page').indeterminate = selectedOnPage > 0 && selectedOnPage < facetOptions.length;
    $('select-review-field-page').disabled = facetLoading || !facetOptions.length;
    $('clear-review-field-selection').disabled = !facetSelected.size;
    $('apply-review-field-filter').disabled = facetLoading;
    for (const [value, checkbox] of facetBoxes) checkbox.checked = facetSelected.has(value);
  }
  function closeFacet() { facetSequence += 1; facetController?.abort(); clearTimeout(facetTimer); facetKey = null; facetSelected.clear(); facetBoxes.clear(); $('review-field-filter-dialog').close(); }
  async function loadOptions() {
    const dataset = getDataset(); if (!dataset || facetKey === null) return;
    const key = facetKey, sequence = ++facetSequence; facetController?.abort(); facetController = new AbortController();
    facetLoading = true; facetOptions = []; facetBoxes.clear();
    $('review-field-values').replaceChildren(); facetSelectionState(); showError('review-field-filter-error'); $('review-field-options-count').textContent = '正在读取分类…';
    $('review-field-options-prev').disabled = $('review-field-options-next').disabled = true;
    try {
      const data = await request(endpoint + '/' + dataset.id + '/field-options?' + new URLSearchParams({ field: key, query: $('review-field-options-search').value.trim(), page: String(facetPage) }), { signal: AbortSignal.any([facetController.signal, AbortSignal.timeout(15000)]) });
      if (sequence !== facetSequence) return;
      facetPage = data.page; facetPages = data.totalPages; facetOptions = data.options;
      $('review-field-values').replaceChildren(...data.options.map(option => {
        const label = node('label', 'review-field-option');
        const checkbox = node('input'); checkbox.type = 'checkbox'; checkbox.checked = facetSelected.has(option.value); checkbox.setAttribute('aria-label', '选择分类：' + option.label); checkbox.value = option.value;
        checkbox.addEventListener('change', () => { if (checkbox.checked) facetSelected.set(option.value, { value: option.value, label: option.label }); else facetSelected.delete(option.value); facetSelectionState(); });
        label.append(checkbox, node('span', '', option.label + (option.truncated ? '…' : '') + ' · ' + (typeLabels[option.type] || option.type) + '（' + option.count + '题）')); label.title = option.label; facetBoxes.set(option.value, checkbox); return label;
      }));
      $('review-field-options-count').textContent = '共 ' + data.totalCategories + ' 类 · 当前匹配 ' + data.total + ' 类 · ' + facetPage + ' / ' + facetPages + ' 页';
    } catch (error) { if (sequence === facetSequence && error.name !== 'AbortError') { showError('review-field-filter-error', error.message || '分类读取失败。'); $('review-field-options-count').textContent = ''; } }
    finally { if (sequence === facetSequence) { facetLoading = false; facetSelectionState(); $('review-field-options-prev').disabled = facetPage <= 1; $('review-field-options-next').disabled = facetPage >= facetPages; } }
  }
  async function openFacet(key) {
    if (isBusy()) return;
    facetKey = key; facetPage = 1; facetOptions = []; $('review-field-options-search').value = '';
    facetSelected.clear(); for (const option of filters.get(key) || []) facetSelected.set(option.value, { ...option });
    $('review-field-filter-title').textContent = '筛选：' + (key || '""');
    $('review-field-filter-description').textContent = (getDataset()?.fieldSettings?.find(field => field.key === key)?.description || '选择分类值进行筛选。') + ' 同一字段多选满足任意一项，不同字段同时满足。';
    $('review-field-filter-dialog').showModal(); await loadOptions();
  }
  for (const id of ['close-review-field-filter', 'cancel-review-field-filter']) $(id).addEventListener('click', closeFacet);
  $('review-field-filter-dialog').addEventListener('cancel', event => { event.preventDefault(); closeFacet(); });
  $('review-field-options-search').addEventListener('input', () => { clearTimeout(facetTimer); facetSequence += 1; facetController?.abort(); facetOptions = []; facetBoxes.clear(); facetLoading = true; $('review-field-values').replaceChildren(); facetSelectionState(); facetPage = 1; facetTimer = setTimeout(loadOptions, 250); });
  $('select-review-field-page').addEventListener('change', () => {
    if (facetLoading) return;
    for (const option of facetOptions) { if ($('select-review-field-page').checked) facetSelected.set(option.value, { value: option.value, label: option.label }); else facetSelected.delete(option.value); }
    facetSelectionState();
  });
  $('clear-review-field-selection').addEventListener('click', () => { facetSelected.clear(); facetSelectionState(); });
  $('review-field-options-prev').addEventListener('click', async () => { if (facetPage > 1) { facetPage -= 1; await loadOptions(); } });
  $('review-field-options-next').addEventListener('click', async () => { if (facetPage < facetPages) { facetPage += 1; await loadOptions(); } });
  $('apply-review-field-filter').addEventListener('click', async () => {
    if (facetKey === null || facetLoading) return;
    if (facetSelected.size) filters.set(facetKey, [...facetSelected.values()].map(option => ({ ...option }))); else filters.delete(facetKey);
    closeFacet(); chips(); await onFilterChanged();
  });
  $('clear-review-field-filter').addEventListener('click', async () => { if (facetKey !== null) filters.delete(facetKey); closeFacet(); chips(); await onFilterChanged(); });
  return {
    update, openConfig,
    reset() { filters.clear(); closeFacet(); closeConfig(); chips(); },
    isOpen: () => (!readOnly && $('review-fields-dialog').open) || $('review-field-filter-dialog').open,
    getFilters: () => filters.size ? { fieldFilters: JSON.stringify([...filters].map(([key, options]) => ({ key, values: options.map(option => option.value) }))) } : {},
    decorateHeading(heading, key) {
      const field = getDataset()?.fieldSettings?.find(item => item.key === key); if (!field?.filterable && !field?.description) return;
      heading.textContent = '';
      if (field.filterable) {
        const button = node('button', 'review-field-filter-button' + (filters.has(key) ? ' active' : ''), (key || '""') + ' ▾'); button.type = 'button'; button.setAttribute('aria-label', '筛选字段：' + key); button.title = field.description || '按这个字段的实际值筛选';
        button.addEventListener('click', () => openFacet(key)); heading.append(button);
      } else heading.append(node('span', '', key || '""'));
      if (field.description) { const description = node('small', 'review-field-description', field.description); description.title = field.description; heading.append(description); }
    }
  };
}
