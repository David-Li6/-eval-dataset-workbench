'use strict';
const $ = id => document.getElementById(id);
let providers = [];
let editing = null;
let deleting = null;
let busy = false;
let deletingBusy = false;
let testReceipt = null;
let loadingVersion = 0;
let noticeTimer;

function notify(message, kind = '') {
  clearTimeout(noticeTimer);
  $('notice').textContent = message;
  $('notice').className = 'notice ' + kind;
  $('notice').hidden = !message;
  if (kind === 'success') noticeTimer = setTimeout(() => { $('notice').hidden = true; }, 6000);
}
async function request(url, { method = 'GET', body, timeout = 10000 } = {}) {
  const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeout) });
  const data = await response.json().catch(() => { throw new Error('本地服务返回无效响应，请重新启动工具。'); });
  return { ...data, responseOk: response.ok };
}
function messageFor(error) {
  if (error.name === 'TimeoutError') return '等待本地服务超时，请稍后重试。';
  if (error instanceof TypeError) return '无法连接本地工具，请运行“启动工具.cmd”后重试。';
  return error.message || '操作失败，请重试。';
}
function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#' + name);
  svg.append(use);
  return svg;
}
function render() {
  const query = $('search').value.trim().toLowerCase();
  const visible = providers.filter(p => [p.name, p.baseUrl, ...p.models].some(value => value.toLowerCase().includes(query)));
  $('provider-count').textContent = providers.length;
  $('provider-count').hidden = !providers.length;
  $('empty-state').hidden = providers.length > 0;
  $('no-results').hidden = !providers.length || visible.length > 0;
  const cards = visible.map(provider => {
    const card = el('article', 'provider-card');
    const content = el('div', 'card-content');
    const top = el('div', 'card-top');
    top.append(icon('provider-icon', 'provider-symbol'));
    const test = provider.lastTest;
    const status = el('span', 'provider-status ' + (test ? test.ok ? 'success' : 'error' : ''));
    status.append(el('span', 'dot'), el('span', '', test ? test.ok ? '可用（已测试）' : '连接失败' : '未测试（有模型）'));
    status.title = test ? '测试模型：' + test.model + '；时间：' + new Date(test.testedAt).toLocaleString('zh-CN') + '。此状态仅代表该模型最近一次测试结果。' : '已保存配置，尚未验证模型连接';
    top.append(status);
    const title = el('div', 'card-title');
    title.append(el('h2', '', provider.name), el('span', 'custom-tag', '自定义'));
    const meta = el('dl', 'provider-meta');
    meta.append(el('dt', '', 'Base URL:'), el('dd', 'address', provider.baseUrl), el('dt', '', 'API Key:'), el('dd', provider.hasApiKey ? '' : 'unset', provider.hasApiKey ? '******' : '未设置'), el('dt', '', 'Model:'), el('dd', '', provider.models.length + ' 个模型'));
    content.append(top, title, meta);
    const actions = el('div', 'card-actions');
    for (const [name, className, action] of [['模型', '', () => openEditor(provider, 'models')], ['设置', '', () => openEditor(provider)], ['删除', 'danger', () => openDelete(provider)]]) {
      const button = el('button', 'button ' + className, name);
      button.type = 'button';
      button.setAttribute('aria-label', name + '：' + provider.name);
      button.addEventListener('click', action);
      actions.append(button);
    }
    card.append(content, actions);
    return card;
  });
  $('providers-grid').replaceChildren(...cards);
}
async function loadProviders() {
  const version = ++loadingVersion;
  $('refresh').disabled = true;
  $('add-provider').disabled = true;
  $('loading').hidden = providers.length > 0;
  try {
    const data = await request('/api/providers');
    if (!data.responseOk) throw new Error(data.error?.message || '读取模型配置失败。');
    if (version !== loadingVersion) return;
    providers = data.providers;
    render();
  } catch (error) { notify(messageFor(error), 'error'); }
  finally {
    if (version === loadingVersion) {
      $('loading').hidden = true;
      $('refresh').disabled = false;
      $('add-provider').disabled = false;
    }
  }
}
function switchTab(name, focus = false) {
  for (const item of ['connection', 'models']) {
    const selected = name === item;
    $(item + '-panel').hidden = !selected;
    $(item + '-tab').setAttribute('aria-selected', String(selected));
    $(item + '-tab').tabIndex = selected ? 0 : -1;
  }
  if (focus) $(name === 'models' ? 'model-names' : 'provider-name').focus();
}
function modelNames() { return [...new Set($('model-names').value.split(/\r?\n/).map(value => value.trim()).filter(Boolean))]; }
function syncModels() {
  const selected = $('test-model').value;
  const names = modelNames();
  $('model-count').textContent = names.length;
  $('test-model').replaceChildren(...(names.length ? names.map(name => new Option(name, name)) : [new Option('请先在模型管理中填写模型', '')]));
  if (names.includes(selected)) $('test-model').value = selected;
}
function endpointPreview() {
  const value = $('base-url').value.trim();
  if (!value) return '填写 Base URL 后显示';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return '请输入有效的 HTTP / HTTPS 接口地址';
    const pathname = url.pathname.replace(/\/+$/, '');
    const base = pathname.replace(/\/models$/, '');
    url.pathname = pathname.endsWith('/chat/completions') ? pathname : (base || '/v1') + '/chat/completions';
    return url.toString();
  } catch { return '请填写完整地址，例如 http://127.0.0.1:8000/v1'; }
}
function invalidateTest() {
  testReceipt = null;
  $('test-result').hidden = true;
  $('result-output').textContent = '';
  $('save-note').textContent = '保存后可在列表中继续管理';
}
function openEditor(provider = null, tab = 'connection') {
  editing = provider;
  $('provider-form').reset();
  $('editor-fields').disabled = false;
  $('editor-error').hidden = true;
  $('dialog-title').textContent = provider ? '模型配置 · ' + provider.name : '添加模型配置';
  $('dialog-subtitle').textContent = provider ? '修改配置、管理模型或测试连接' : '配置 OpenAI 兼容的模型服务';
  $('provider-name').value = provider?.name || '';
  $('base-url').value = provider?.baseUrl || '';
  $('model-names').value = provider?.models.join('\n') || '';
  const timeout = String(provider?.timeoutSeconds || 60);
  if (![...$('timeout').options].some(option => option.value === timeout)) $('timeout').add(new Option(timeout + ' 秒', timeout));
  $('timeout').value = timeout;
  $('api-key').type = 'password';
  $('api-key').disabled = false;
  $('api-key').placeholder = provider?.hasApiKey ? '已保存密钥，留空保持不变' : '无需鉴权时留空';
  $('toggle-key').textContent = '显示';
  $('toggle-key').setAttribute('aria-label', '显示 API Key');
  $('toggle-key').setAttribute('aria-pressed', 'false');
  $('clear-key-label').hidden = !provider?.hasApiKey;
  $('key-hint').textContent = provider?.hasApiKey ? '留空保留原密钥；输入新密钥后保存即可替换。' : '保存后会加密存储，列表中仅显示遮罩。';
  for (const input of $('provider-form').querySelectorAll('input,textarea')) input.setCustomValidity('');
  syncModels();
  $('endpoint-preview').textContent = endpointPreview();
  invalidateTest();
  switchTab(tab);
  $('provider-dialog').showModal();
  $(tab === 'models' ? 'model-names' : 'provider-name').focus();
}
function closeEditor() {
  if (busy) return;
  $('provider-dialog').close();
  $('api-key').value = '';
  editing = null;
  invalidateTest();
}
function validate(full = true) {
  const name = $('provider-name');
  const urlInput = $('base-url');
  name.value = name.value.trim();
  urlInput.value = urlInput.value.trim();
  if (full && !name.checkValidity()) { switchTab('connection'); name.reportValidity(); return false; }
  try {
    const url = new URL(urlInput.value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    switchTab('connection');
    urlInput.setCustomValidity('请输入 HTTP 或 HTTPS 地址，不要包含用户名、密码或查询参数。');
    urlInput.reportValidity();
    return false;
  }
  const names = modelNames();
  if (!names.length || names.length > 100 || names.some(value => value.length > 256)) {
    switchTab('models');
    $('model-names').setCustomValidity('请填写 1–100 个模型名称，每行一个，每个名称不超过 256 字符。');
    $('model-names').reportValidity();
    return false;
  }
  return true;
}
function body() {
  return { name: $('provider-name').value.trim(), baseUrl: $('base-url').value.trim(), models: modelNames(), timeoutSeconds: Number($('timeout').value), clearApiKey: $('clear-key').checked, ...($('api-key').value.trim() ? { apiKey: $('api-key').value.trim() } : {}), ...(editing ? { revision: editing.revision } : {}) };
}
function setBusy(value) {
  busy = value;
  $('editor-fields').disabled = value;
  for (const id of ['close-dialog', 'cancel-dialog', 'save-provider']) $(id).disabled = value;
}
function editorError(message) { $('editor-error').textContent = message; $('editor-error').hidden = !message; }
async function testConnection() {
  if (busy || !validate(false)) return;
  const config = body();
  config.model = $('test-model').value;
  if (editing) config.id = editing.id;
  setBusy(true);
  editorError('');
  invalidateTest();
  $('test-result').hidden = false;
  $('test-result').className = 'test-result';
  $('result-title').textContent = '正在连接模型...';
  $('result-meta').textContent = '';
  $('result-description').textContent = '等待模型回复，最长 ' + config.timeoutSeconds + ' 秒。';
  $('result-output').hidden = true;
  const start = Date.now();
  const timer = setInterval(() => { $('test-button-text').textContent = '测试中 ' + Math.floor((Date.now() - start) / 1000) + 's'; }, 1000);
  try {
    const data = await request('/api/providers/test', { method: 'POST', body: config, timeout: (config.timeoutSeconds + 25) * 1000 });
    testReceipt = data.testReceipt || null;
    $('test-result').className = 'test-result ' + (data.ok ? 'success' : 'error');
    $('result-title').textContent = data.ok ? '连接成功' : '连接失败';
    $('result-meta').textContent = [data.httpStatus ? 'HTTP ' + data.httpStatus : '', Number.isFinite(data.latencyMs) ? (data.latencyMs / 1000).toFixed(2) + ' 秒' : ''].filter(Boolean).join(' · ');
    $('result-description').textContent = data.ok ? '模型已正常回复。点击保存，将保留本次测试状态。' : data.error?.message || '测试失败，请检查配置。';
    $('result-output').textContent = data.ok ? data.reply : data.error?.detail || '';
    $('result-output').hidden = !$('result-output').textContent;
    $('save-note').textContent = data.ok ? '测试通过，保存后生效' : '可保存配置后继续排查';
  } catch (error) {
    $('test-result').className = 'test-result error';
    $('result-title').textContent = '连接失败';
    $('result-description').textContent = messageFor(error);
  } finally {
    clearInterval(timer);
    $('test-button-text').textContent = '测试连接';
    setBusy(false);
  }
}
$('provider-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !validate()) return;
  const config = { ...body(), ...(testReceipt ? { testReceipt } : {}) };
  const currentId = editing?.id;
  setBusy(true);
  editorError('');
  $('save-provider').textContent = '正在保存...';
  try {
    const data = await request(currentId ? '/api/providers/' + currentId : '/api/providers', { method: currentId ? 'PUT' : 'POST', body: config, timeout: 40000 });
    if (!data.responseOk) throw new Error(data.error?.message || '保存失败。');
    providers = currentId ? providers.map(item => item.id === currentId ? data.provider : item) : [...providers, data.provider];
    $('search').value = '';
    render();
    setBusy(false);
    closeEditor();
    notify(currentId ? '模型配置已保存。' : '模型配置已添加，刷新页面后仍会保留。', 'success');
  } catch (error) { editorError(messageFor(error)); }
  finally { setBusy(false); $('save-provider').textContent = '保存模型配置'; }
});
function openDelete(provider) {
  deleting = provider;
  $('delete-description').textContent = '确定从列表中删除“' + provider.name + '”吗？此配置将不再用于模型调用。';
  $('delete-error').hidden = true;
  $('delete-dialog').showModal();
  $('cancel-delete').focus();
}
$('confirm-delete').addEventListener('click', async () => {
  if (!deleting || deletingBusy) return;
  deletingBusy = true;
  $('confirm-delete').disabled = $('cancel-delete').disabled = true;
  try {
    const data = await request('/api/providers/' + deleting.id, { method: 'DELETE', body: { revision: deleting.revision } });
    if (!data.responseOk) throw new Error(data.error?.message || '删除失败。');
    providers = providers.filter(item => item.id !== deleting.id);
    render();
    $('delete-dialog').close();
    deleting = null;
    notify('模型配置已从列表删除。', 'success');
  } catch (error) { $('delete-error').textContent = messageFor(error); $('delete-error').hidden = false; }
  finally { deletingBusy = false; $('confirm-delete').disabled = $('cancel-delete').disabled = false; }
});
$('cancel-delete').addEventListener('click', () => { if (!deletingBusy) $('delete-dialog').close(); });
$('delete-dialog').addEventListener('cancel', event => { if (deletingBusy) event.preventDefault(); });
$('provider-dialog').addEventListener('cancel', event => { event.preventDefault(); closeEditor(); });
$('add-provider').addEventListener('click', () => openEditor());
$('add-first').addEventListener('click', () => openEditor());
$('close-dialog').addEventListener('click', closeEditor);
$('cancel-dialog').addEventListener('click', closeEditor);
$('refresh').addEventListener('click', () => { notify(''); loadProviders(); });
$('search').addEventListener('input', render);
$('clear-search').addEventListener('click', () => { $('search').value = ''; render(); });
$('test-connection').addEventListener('click', testConnection);
for (const tab of ['connection', 'models']) {
  $(tab + '-tab').addEventListener('click', () => switchTab(tab));
  $(tab + '-tab').addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 'connection' : event.key === 'End' ? 'models' : tab === 'models' ? 'connection' : 'models';
      switchTab(next);
      $(next + '-tab').focus();
    }
  });
}
for (const input of $('editor-fields').querySelectorAll('input,textarea,select')) input.addEventListener('input', () => {
  input.setCustomValidity('');
  editorError('');
  if (input.id !== 'provider-name') invalidateTest();
  if (input.id === 'model-names') syncModels();
  if (input.id === 'base-url') $('endpoint-preview').textContent = endpointPreview();
});
$('clear-key').addEventListener('change', () => {
  $('api-key').disabled = $('clear-key').checked;
  if ($('clear-key').checked) $('api-key').value = '';
});
$('toggle-key').addEventListener('click', () => {
  const visible = $('api-key').type === 'password';
  $('api-key').type = visible ? 'text' : 'password';
  $('toggle-key').textContent = visible ? '隐藏' : '显示';
  $('toggle-key').setAttribute('aria-label', (visible ? '隐藏' : '显示') + ' API Key');
  $('toggle-key').setAttribute('aria-pressed', String(visible));
});
loadProviders();

