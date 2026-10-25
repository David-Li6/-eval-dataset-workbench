import { extractVariables } from './prompt-utils.js';
import { automaticVariables, defaultGenerationPrompt } from './generation-utils.js';
import { node } from './review-render.js';
const $ = id => document.getElementById(id);

export function initSourceGeneration({ notify }) {
  const selected = new Set(), boxes = new Map();
  let allFiles = [], visibleFiles = [], providers = [], templates = [], busy = false, loading = false, openSequence = 0, variableInputs = new Map();
  const supported = file => file.generationSupported ?? file.previewSupported;
  function update() {
    const visible = visibleFiles.filter(supported); const selectedVisible = visible.filter(file => selected.has(file.id)).length;
    $('source-selection-count').textContent = '已选择 ' + selected.size + ' 个源文件';
    $('select-source-files').checked = !!visible.length && selectedVisible === visible.length;
    $('select-source-files').indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    $('select-source-files').disabled = !visible.length || busy;
    $('clear-source-selection').disabled = !selected.size || busy;
    $('generate-from-sources').disabled = !selected.size || busy;
    for (const [id, input] of boxes) input.checked = selected.has(id);
  }
  function error(text = '') { $('generation-error').textContent = text; $('generation-error').hidden = !text; }
  function variables() {
    const prior = Object.fromEntries([...variableInputs].map(([name, input]) => [name, input.value])); variableInputs = new Map();
    const names = extractVariables($('generation-prompt').value).filter(name => !automaticVariables.includes(name));
    $('generation-variables').replaceChildren(...names.map((name, index) => {
      const field = node('div', 'field'); const label = node('label', '', name); const input = node('textarea'); input.rows = 2; input.id = 'generation-variable-' + index; input.maxLength = 10000; label.htmlFor = input.id; input.value = prior[name] || ''; field.append(label, input); variableInputs.set(name, input); return field;
    }));
    $('generation-variables-section').hidden = !names.length;
  }
  function modelOptions() {
    const provider = providers.find(item => item.id === $('generation-provider').value);
    $('generation-model').replaceChildren(...(provider?.models || []).map(name => new Option(name, name)));
    $('generation-destination').textContent = provider ? '模型服务：' + provider.baseUrl + '。开始生成后，所选文件内容会发送到此服务。' : '请先在“模型配置”页面添加可用模型。';
  }
  function close() { if (!busy) { openSequence += 1; loading = false; $('generation-dialog').close(); } }
  $('select-source-files').addEventListener('change', () => {
    const visible = visibleFiles.filter(supported);
    if ($('select-source-files').checked) {
      const next = new Set([...selected, ...visible.map(file => file.id)]);
      if (next.size > 20) { notify('一次最多选择 20 个源文件，请减少勾选。', 'error'); update(); return; }
      for (const file of visible) selected.add(file.id);
    } else for (const file of visible) selected.delete(file.id);
    update();
  });
  $('clear-source-selection').addEventListener('click', () => { selected.clear(); update(); });
  $('generate-from-sources').addEventListener('click', async () => {
    if (!selected.size || busy || loading) return;
    loading = true; const sequence = ++openSequence; error(''); $('generation-fields').disabled = true; $('start-source-generation').disabled = true;
    const files = allFiles.filter(file => selected.has(file.id));
    $('generation-selected-files').replaceChildren(...files.map(file => node('span', 'generation-file-chip', file.name)));
    $('generation-name').value = (files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '') : '多源文档') .slice(0, 70) + '_评测集';
    $('generation-count').value = '200'; $('generation-batch-size').value = '5'; $('generation-timeout').value = '180'; $('generation-max-tokens').value = '8192';
    $('generation-prompt').value = defaultGenerationPrompt; variableInputs.clear(); variables(); $('generation-dialog').showModal();
    try {
      const responses = await Promise.all([fetch('/api/providers', { signal: AbortSignal.timeout(10000) }), fetch('/api/prompts', { signal: AbortSignal.timeout(10000) })]);
      const data = await Promise.all(responses.map(response => response.json()));
      if (sequence !== openSequence) return;
      if (!responses[0].ok || !responses[1].ok) throw new Error(data.find(item => item.error)?.error.message || '配置读取失败，请重试。');
      providers = data[0].providers; templates = data[1].templates;
      $('generation-provider').replaceChildren(...providers.map(provider => new Option(provider.name, provider.id))); modelOptions();
      $('generation-template').replaceChildren(new Option('默认评测集生成提示词', ''), ...templates.map(template => new Option(template.name, template.id)));
      $('generation-fields').disabled = false; $('start-source-generation').disabled = !providers.length;
      if (!providers.length) error('还没有模型配置，请先添加模型配置后再生成。');
    } catch (err) { if (sequence === openSequence) error(err.message || '无法读取生成配置。'); }
    finally { if (sequence === openSequence) loading = false; }
  });
  $('generation-provider').addEventListener('change', modelOptions);
  $('generation-template').addEventListener('change', () => { $('generation-prompt').value = templates.find(template => template.id === $('generation-template').value)?.content || defaultGenerationPrompt; variables(); });
  $('generation-prompt').addEventListener('input', variables);
  for (const id of ['close-generation-dialog', 'cancel-source-generation']) $(id).addEventListener('click', close);
  $('generation-dialog').addEventListener('cancel', event => { event.preventDefault(); close(); });
  $('source-generation-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || loading) return; error('');
    const values = Object.fromEntries([...variableInputs].map(([name, input]) => [name, input.value]));
    const missing = [...variableInputs].find(([, input]) => !input.value.trim()); if (missing) { error('请填写提示词变量：' + missing[0]); missing[1].focus(); return; }
    busy = true; $('generation-fields').disabled = true; $('start-source-generation').disabled = true; update();
    try {
      const response = await fetch('/api/generations', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fileIds: allFiles.filter(file => selected.has(file.id)).map(file => file.id), providerId: $('generation-provider').value, model: $('generation-model').value, name: $('generation-name').value, count: Number($('generation-count').value), batchSize: Number($('generation-batch-size').value), timeoutSeconds: Number($('generation-timeout').value), maxTokens: Number($('generation-max-tokens').value), prompt: $('generation-prompt').value, values, templateName: templates.find(template => template.id === $('generation-template').value)?.name || '默认/自定义提示词' }), signal: AbortSignal.timeout(30000) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error?.message || '任务创建失败。');
      $('generation-dialog').close(); location.href = '/source-datasets?job=' + encodeURIComponent(data.job.id);
    } catch (err) { error(err.name === 'TimeoutError' ? '创建任务超时，请到“源文件生成评测集”确认任务是否已创建。' : err.message || '无法连接本地工具。'); }
    finally { busy = false; $('generation-fields').disabled = false; $('start-source-generation').disabled = false; update(); }
  });
  update();
  return {
    render(files, visible) { allFiles = files; visibleFiles = visible; boxes.clear(); for (const id of selected) if (!files.some(file => file.id === id)) selected.delete(id); update(); },
    checkbox(file) {
      const input = node('input', 'source-file-checkbox'); input.type = 'checkbox'; input.checked = selected.has(file.id); input.disabled = !supported(file); input.title = supported(file) ? '选择此文件用于 AI 生成' : '此格式暂不支持 AI 生成'; input.setAttribute('aria-label', '选择源文件：' + file.name);
      input.addEventListener('change', () => { if (input.checked && selected.size >= 20) { input.checked = false; notify('一次最多选择 20 个源文件。', 'error'); return; } if (input.checked) selected.add(file.id); else selected.delete(file.id); update(); }); boxes.set(file.id, input); return input;
    }
  };
}
