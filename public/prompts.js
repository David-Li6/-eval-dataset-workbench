import { extractVariables, renderTemplate } from './prompt-utils.js';

const $ = id => document.getElementById(id);
let templates = [];
let editing = null;
let using = null;
let deleting = null;
let editorBusy = false;
let deleteBusy = false;
let loadVersion = 0;
let baseline = '';
let noticeTimer;

const example = {
  name: '评测问题生成', category: '评测集构建', description: '基于参考资料生成评测题，并给出参考答案和评分标准。',
  content: '你是一名{{领域}}领域的模型评测专家。\n\n请根据以下参考资料，构建{{题目数量}}道评测题。\n\n要求：\n1. 问题贴近真实用户的自然提问。\n2. 答案应符合资料中的专家结论和业务口径，不编造缺失的数据。\n3. 为每道题给出明确、可执行的得分标准。\n4. 输出 JSON 数组，每条包含 Question、User Question、SELECT Data、answer、Scoring criteria、difficulty、Task family、source 字段。\n\n参考资料：\n{{参考资料}}'
};

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function notify(text, kind = '') {
  clearTimeout(noticeTimer);
  $('prompt-notice').textContent = text;
  $('prompt-notice').className = 'notice ' + kind;
  $('prompt-notice').hidden = !text;
  if (kind === 'success') noticeTimer = setTimeout(() => { $('prompt-notice').hidden = true; }, 6000);
}
function errorMessage(error) {
  if (error.name === 'TimeoutError') return '本地服务响应超时，请稍后重试。';
  if (error instanceof TypeError) return '无法连接本地工具，请运行“启动工具.cmd”后重试。';
  return error.message || '操作失败，请重试。';
}
async function request(path, method = 'GET', body) {
  const response = await fetch(path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => { throw new Error('本地服务返回异常，请重新启动工具。'); });
  if (!response.ok) throw new Error(data.error?.message || '请求未成功。');
  return data;
}
function updateCategories() {
  const selected = $('category-filter').value;
  const categories = [...new Set(templates.map(item => item.category))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  $('category-filter').replaceChildren(new Option('全部分类', ''), ...categories.map(category => new Option(category, category)));
  if (categories.includes(selected)) $('category-filter').value = selected;
  $('template-categories').replaceChildren(...categories.filter(value => value !== '未分类').map(value => new Option(value, value)));
}
function renderLibrary() {
  const query = $('template-search').value.trim().toLocaleLowerCase();
  const category = $('category-filter').value;
  const visible = templates.filter(item => (!category || item.category === category) && [item.name, item.category, item.description, item.content].some(text => text.toLocaleLowerCase().includes(query))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  $('template-count').textContent = templates.length;
  $('template-count').hidden = !templates.length;
  $('templates-summary').textContent = '共 ' + templates.length + ' 个模板 · ' + new Set(templates.map(item => item.category)).size + ' 个分类';
  $('templates-empty').hidden = templates.length > 0;
  $('template-no-results').hidden = !templates.length || visible.length > 0;
  $('templates-grid').replaceChildren(...visible.map(template => {
    const card = node('article', 'template-card');
    const top = node('div', 'template-card-top');
    const category = node('span', 'template-category', template.category);
    category.title = template.category;
    const date = node('span', 'template-date', new Date(template.updatedAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' 更新');
    date.title = new Date(template.updatedAt).toLocaleString('zh-CN', { hour12: false });
    top.append(category, date);
    const title = node('h2', 'template-title');
    const titleButton = node('button', '', template.name);
    titleButton.type = 'button'; titleButton.setAttribute('aria-label', '查看模板：' + template.name);
    titleButton.addEventListener('click', () => openUse(template));
    title.append(titleButton);
    card.append(top, title);
    if (template.description) card.append(node('p', 'template-description', template.description));
    const excerpt = node('div', 'template-excerpt'); excerpt.append(node('pre', '', template.content.slice(0, 450))); card.append(excerpt);
    const variables = node('div', 'template-variables-info');
    variables.append(node('span', '', template.variables.length ? template.variables.length + ' 个变量 · 使用时填写' : '无变量 · 可直接使用'), node('span', '', template.content.length.toLocaleString() + ' 字符'));
    const actions = node('div', 'template-actions');
    for (const [label, className, action] of [
      ['使用模板', 'button use-button', () => openUse(template)],
      ['复制原文', 'text-action', () => copyOriginal(template)],
      ['编辑', 'text-action', () => openEditor(template)],
      ['删除', 'text-action delete-action', () => openDelete(template)]
    ]) {
      const button = node('button', className, label); button.type = 'button'; button.setAttribute('aria-label', label + '：' + template.name); button.addEventListener('click', action); actions.append(button);
    }
    card.append(variables, actions);
    return card;
  }));
}
async function loadLibrary() {
  const version = ++loadVersion;
  $('refresh-templates').disabled = $('add-template').disabled = true;
  $('templates-loading').hidden = templates.length > 0;
  try {
    const data = await request('/api/prompts');
    if (version !== loadVersion) return;
    templates = data.templates;
    updateCategories(); renderLibrary();
  } catch (error) { notify(errorMessage(error), 'error'); }
  finally {
    if (version === loadVersion) { $('templates-loading').hidden = true; $('refresh-templates').disabled = $('add-template').disabled = false; }
  }
}
function editorValues() {
  return { name: $('template-name').value.trim(), category: $('template-category').value.trim(), description: $('template-description').value.trim(), content: $('template-content').value };
}
function updateVariables() {
  const content = $('template-content').value;
  const names = extractVariables(content);
  $('content-count').textContent = content.length.toLocaleString() + ' / 50,000';
  $('editor-variables').replaceChildren(...(names.length ? names.map(name => node('span', '', name)) : [node('span', 'no-variables', '尚未设置，可直接使用正文')]));
}
function openEditor(template = null, fromExample = false) {
  editing = template;
  $('template-form').reset();
  $('template-error').hidden = true;
  $('editor-title').textContent = template ? '编辑提示词模板' : '添加提示词模板';
  const content = template || (fromExample ? example : { name: '', category: '', description: '', content: '' });
  for (const key of ['name', 'category', 'description', 'content']) {
    $('template-' + key).value = content[key];
    $('template-' + key).setCustomValidity('');
  }
  updateVariables();
  baseline = JSON.stringify(editorValues());
  $('template-editor').showModal();
  $('template-name').focus();
}
function closeEditor(force = false) {
  if (editorBusy) return;
  if (!force && baseline !== JSON.stringify(editorValues()) && !window.confirm('模板还未保存，确定放弃本次修改吗？')) return;
  $('template-editor').close(); $('template-form').reset(); editing = null; baseline = '';
}
function setEditorBusy(value) {
  editorBusy = value;
  $('template-fields').disabled = value;
  for (const id of ['save-template', 'cancel-editor', 'close-editor']) $(id).disabled = value;
}
function validateEditor() {
  const content = $('template-content');
  content.setCustomValidity(!content.value.trim() ? '请填写提示词正文。' : extractVariables(content.value).length > 100 ? '一个模板最多配置 100 个不同的变量。' : '');
  return $('template-form').reportValidity();
}
$('template-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (editorBusy || !validateEditor()) return;
  const config = { ...editorValues(), ...(editing ? { revision: editing.revision } : {}) };
  const id = editing?.id;
  setEditorBusy(true); $('template-error').hidden = true; $('save-template').textContent = '正在保存...';
  try {
    const data = await request(id ? '/api/prompts/' + id : '/api/prompts', id ? 'PUT' : 'POST', config);
    templates = id ? templates.map(item => item.id === id ? data.template : item) : [...templates, data.template];
    $('template-search').value = ''; $('category-filter').value = '';
    updateCategories(); renderLibrary();
    setEditorBusy(false); closeEditor(true);
    notify('模板已保存，下次打开提示词库可继续使用。', 'success');
  } catch (error) { $('template-error').textContent = errorMessage(error); $('template-error').hidden = false; }
  finally { setEditorBusy(false); $('save-template').textContent = '保存模板'; }
});
function currentRender() {
  const values = Object.fromEntries([...$('variable-inputs').querySelectorAll('textarea')].map(input => [input.dataset.variable, input.value]));
  return renderTemplate(using.content, values);
}
function updateRendered() {
  if (!using) return;
  const rendered = currentRender();
  $('rendered-prompt').value = rendered.text;
  $('render-status').textContent = rendered.missingVariables.length ? '还有 ' + rendered.missingVariables.length + ' 个变量未填写' : using.variables.length ? '已填写全部变量' : '可直接使用';
  $('render-status').className = rendered.missingVariables.length ? '' : 'complete';
  $('copy-completed').disabled = rendered.missingVariables.length > 0;
  $('use-error').hidden = true;
  $('use-tip').textContent = '复制后可直接粘贴到模型输入中';
}
function openUse(template) {
  using = template;
  $('use-title').textContent = template.name;
  $('use-description').textContent = template.description || template.category;
  $('use-body').className = 'use-body' + (template.variables.length ? '' : ' no-variables');
  $('copy-original').hidden = !template.variables.length;
  $('variable-inputs').replaceChildren(...template.variables.map((name, index) => {
    const field = node('div', 'field');
    const label = node('label', '', name + ' *'); label.htmlFor = 'prompt-variable-' + index;
    const input = node('textarea'); input.id = 'prompt-variable-' + index; input.rows = 2; input.dataset.variable = name; input.maxLength = 50000; input.placeholder = '填写' + name; input.addEventListener('input', updateRendered);
    field.append(label, input); return field;
  }));
  updateRendered(); $('use-template-dialog').showModal();
  if (template.variables.length) $('variable-inputs').querySelector('textarea').focus();
  else $('copy-completed').focus();
}
function closeUse() {
  $('use-template-dialog').close(); using = null;
  $('variable-inputs').replaceChildren(); $('rendered-prompt').value = '';
}
async function copyOriginal(template, inDialog = false) {
  try {
    await navigator.clipboard.writeText(template.content);
    if (inDialog) { $('use-tip').textContent = '模板原文已复制，包含变量占位符'; $('use-error').hidden = true; }
    else notify(template.variables.length ? '模板原文已复制，包含变量占位符。' : '提示词已复制，可以直接粘贴使用。', 'success');
  } catch {
    if (inDialog) { $('use-error').textContent = '浏览器未允许复制，请从模板编辑窗口选中正文复制。'; $('use-error').hidden = false; }
    else notify('浏览器未允许复制，请打开模板编辑窗口，选中正文后按 Ctrl+C。', 'error');
  }
}
$('copy-completed').addEventListener('click', async () => {
  if (!using) return;
  const rendered = currentRender();
  if (rendered.missingVariables.length) return;
  try {
    await navigator.clipboard.writeText(rendered.text);
    $('use-tip').textContent = '完整提示词已复制，可以粘贴到模型中使用'; $('use-error').hidden = true;
  } catch {
    $('rendered-prompt').focus(); $('rendered-prompt').select();
    $('use-error').textContent = '复制未成功，已选中完整提示词，可按 Ctrl+C 复制。'; $('use-error').hidden = false;
  }
});
$('copy-original').addEventListener('click', () => { if (using) copyOriginal(using, true); });
function openDelete(template) {
  deleting = template; $('delete-template-error').hidden = true;
  $('delete-template-description').textContent = '确定从提示词库中删除“' + template.name + '”吗？';
  $('delete-template-dialog').showModal(); $('cancel-delete-template').focus();
}
$('confirm-delete-template').addEventListener('click', async () => {
  if (!deleting || deleteBusy) return;
  deleteBusy = true; $('confirm-delete-template').disabled = $('cancel-delete-template').disabled = true;
  try {
    await request('/api/prompts/' + deleting.id, 'DELETE', { revision: deleting.revision });
    templates = templates.filter(item => item.id !== deleting.id); updateCategories(); renderLibrary();
    $('delete-template-dialog').close(); deleting = null; notify('模板已从提示词库删除。', 'success');
  } catch (error) { $('delete-template-error').textContent = errorMessage(error); $('delete-template-error').hidden = false; }
  finally { deleteBusy = false; $('confirm-delete-template').disabled = $('cancel-delete-template').disabled = false; }
});
for (const id of ['add-template', 'add-first-template']) $(id).addEventListener('click', () => openEditor());
$('create-example').addEventListener('click', () => openEditor(null, true));
for (const id of ['cancel-editor', 'close-editor']) $(id).addEventListener('click', () => closeEditor());
$('template-editor').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('close-use').addEventListener('click', closeUse);
$('use-template-dialog').addEventListener('cancel', event => { event.preventDefault(); closeUse(); });
$('cancel-delete-template').addEventListener('click', () => { if (!deleteBusy) $('delete-template-dialog').close(); });
$('delete-template-dialog').addEventListener('cancel', event => { if (deleteBusy) event.preventDefault(); });
$('refresh-templates').addEventListener('click', () => { notify(''); loadLibrary(); });
$('template-search').addEventListener('input', renderLibrary);
$('category-filter').addEventListener('change', renderLibrary);
$('reset-filters').addEventListener('click', () => { $('template-search').value = ''; $('category-filter').value = ''; renderLibrary(); });
for (const input of $('template-fields').querySelectorAll('input,textarea')) input.addEventListener('input', () => { input.setCustomValidity(''); $('template-error').hidden = true; });
$('template-content').addEventListener('input', updateVariables);
$('insert-variable').addEventListener('click', () => {
  const textarea = $('template-content');
  if (textarea.value.length + 7 > 50000) return;
  textarea.setRangeText('{{变量名}}', textarea.selectionStart, textarea.selectionEnd, 'select');
  textarea.focus(); textarea.setCustomValidity(''); updateVariables();
});
loadLibrary();
