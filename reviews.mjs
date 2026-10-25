import { readFile, writeFile, mkdir, rename, unlink, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatasetError, parseEvaluationDataset, previewReviewRecord } from './review-data.mjs';
import { fieldCategory, describeReviewFields, reviewFieldOptions } from './review-fields.mjs';
import { reviewDistribution } from './review-distribution.mjs';

const MAX_SIZE = 20 * 1024 * 1024;
const datasetFormat = name => /\.jsonl$/i.test(name) ? 'jsonl' : 'json';
export function createReviewsApi({ directory, readJson, json, RequestError }) {
  const indexPath = path.join(directory, 'index.json');
  const workflowPath = path.join(directory, 'workflow.json');
  let queue = Promise.resolve();
  const cache = new Map();
  const serialize = action => { const task = queue.then(action); queue = task.catch(() => {}); return task; };
  async function readIndex() {
    try {
      const store = JSON.parse(await readFile(indexPath, 'utf8'));
      if (store.version !== 1 || !Array.isArray(store.datasets)) throw new Error();
      return store;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, datasets: [] };
      throw new RequestError('REVIEWS_STORE_ERROR', '评测集列表无法读取，已有数据未被覆盖，请检查本机文件。', 500);
    }
  }
  async function readWorkflow() {
    try {
      const store = JSON.parse(await readFile(workflowPath, 'utf8'));
      if (store.version !== 1 || !Array.isArray(store.changes) || !Array.isArray(store.versions) ||
          store.changes.some(item => !item || typeof item.datasetId !== 'string' || !Number.isInteger(item.number) || typeof item.revision !== 'string' || (Object.hasOwn(item, 'record') && (!item.record || typeof item.record !== 'object' || Array.isArray(item.record)))) ||
          store.versions.some(item => !item || typeof item.id !== 'string' || typeof item.name !== 'string' || !Array.isArray(item.questions) || item.questions.some(q => !q || !q.record || typeof q.record !== 'object' || Array.isArray(q.record)))) throw new Error();
      if (store.expertReviews !== undefined && (!Array.isArray(store.expertReviews) || store.expertReviews.some(item => !item || typeof item.datasetId !== 'string' || !Number.isInteger(item.number) || typeof item.revision !== 'string' || !Array.isArray(item.submissions) ||
          (item.draft !== null && (!item.draft || typeof item.draft.text !== 'string' || typeof item.draft.questionRevision !== 'string')) || item.submissions.some(entry => !entry || typeof entry.id !== 'string' || typeof entry.text !== 'string' || typeof entry.questionRevision !== 'string')))) throw new Error();
      store.expertReviews ??= [];
      if (store.fieldConfigs !== undefined && (!Array.isArray(store.fieldConfigs) || store.fieldConfigs.some(item => !item || typeof item.datasetId !== 'string' || typeof item.revision !== 'string' || !Array.isArray(item.fields) || item.fields.some(field => !field || typeof field.key !== 'string' || typeof field.description !== 'string' || typeof field.filterable !== 'boolean')))) throw new Error();
      store.fieldConfigs ??= [];
      return store;
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, changes: [], versions: [], expertReviews: [], fieldConfigs: [] };
      throw new RequestError('WORKFLOW_STORE_ERROR', '审核与冻结版本记录无法读取，已有数据未被覆盖，请检查本机文件。', 500);
    }
  }
  async function atomicWrite(filename, store) {
    await mkdir(directory, { recursive: true });
    const temp = filename + '.' + randomUUID() + '.tmp';
    try { await writeFile(temp, JSON.stringify(store, null, 2) + '\n'); await rename(temp, filename); }
    catch (error) { await unlink(temp).catch(() => {}); throw error; }
  }
  function remember(id, parsed) {
    cache.delete(id); cache.set(id, parsed);
    while (cache.size > 2) cache.delete(cache.keys().next().value);
  }
  async function locate(id, parse = true) {
    const dataset = (await readIndex()).datasets.find(item => item.id === id && !item.deletedAt);
    if (!dataset) throw new RequestError('DATASET_NOT_FOUND', '评测集不存在，请刷新列表。', 404);
    const filename = path.join(directory, id + '.json');
    try {
      const actual = await realpath(filename); const root = await realpath(directory);
      if (!actual.startsWith(root + path.sep)) throw new Error();
    } catch { throw new RequestError('DATASET_NOT_FOUND', '评测集文件不存在或已移动，请重新上传。', 404); }
    let parsed;
    if (parse) {
      parsed = cache.get(id);
      if (!parsed) {
        try { parsed = parseEvaluationDataset(await readFile(filename), { format: datasetFormat(dataset.name) }); }
        catch { throw new RequestError('DATASET_READ_ERROR', '已保存的评测集无法读取，请重新上传原文件。', 500); }
      }
      remember(id, parsed);
    }
    return { dataset, parsed, filename };
  }
  function parseRecords(records) {
    try { return parseEvaluationDataset(Buffer.from(JSON.stringify(records))); }
    catch (error) { if (error instanceof DatasetError) throw new RequestError(error.code, error.message); throw error; }
  }
  const emptyStats = () => ({ questionCount: 0, issueCount: 0, fieldNames: [], fieldCount: 0, difficulties: {}, families: {} });
  function workingView(dataset, parsed, workflow) {
    const changes = new Map(workflow.changes.filter(item => item.datasetId === dataset.id).map(item => [item.number, item]));
    const numbers = []; const records = [];
    parsed.items.forEach((record, index) => {
      const number = index + 1; const change = changes.get(number);
      if (!change?.deletedAt) { numbers.push(number); records.push(change?.record ?? record); }
    });
    const current = records.length ? parseRecords(records) : { stats: emptyStats(), summaries: [] };
    const included = new Map();
    for (const version of workflow.versions.filter(item => !item.deletedAt)) for (const entry of version.questions) {
      if (entry.deletedAt || entry.datasetId !== dataset.id) continue;
      if (!included.has(entry.number)) included.set(entry.number, []);
      included.get(entry.number).push({ id: version.id, name: version.name, revision: entry.sourceRevision });
    }
    const expertReviews = new Map((workflow.expertReviews || []).filter(item => item.datasetId === dataset.id).map(item => [item.number, item]));
    const summaries = current.summaries.map((summary, index) => {
      const number = numbers[index]; const revision = changes.get(number)?.revision || 'original';
      const frozenVersions = (included.get(number) || []).map(({ id, name }) => ({ id, name }));
      const approvedVersions = (included.get(number) || []).filter(item => item.revision === revision).map(({ id, name }) => ({ id, name }));
      const advice = expertReviews.get(number)?.submissions.at(-1);
      const expertAdvice = advice ? { id: advice.id, preview: advice.text.slice(0, 200), submittedAt: advice.submittedAt, isCurrent: advice.questionRevision === revision } : null;
      return { ...summary, searchText: summary.searchText + '\n' + (advice?.text.toLowerCase() || ''), number, revision, status: approvedVersions.length ? 'approved' : 'pending', approvedVersions, frozenVersions, expertAdvice };
    });
    const approvedCount = summaries.filter(item => item.status === 'approved').length;
    const fieldNames = [...new Set([...parsed.stats.fieldNames, ...current.stats.fieldNames])];
    const fieldConfig = workflow.fieldConfigs?.find(item => item.datasetId === dataset.id);
    const configured = new Map((fieldConfig?.fields || []).map(field => [field.key, field]));
    const fieldSettings = fieldNames.map(key => ({ key, description: configured.get(key)?.description || '', filterable: configured.get(key)?.filterable || false }));
    const revision = createHash('sha256').update(JSON.stringify([dataset.id,
      workflow.changes.filter(item => item.datasetId === dataset.id).map(item => [item.number, item.revision]),
      [...expertReviews.values()].map(item => [item.number, item.revision]),
      workflow.versions.filter(item => !item.deletedAt).flatMap(version => version.questions.filter(item => !item.deletedAt && item.datasetId === dataset.id).map(item => [version.id, item.id])), fieldConfig?.revision || 'none'
    ])).digest('hex');
    return { dataset: { ...dataset, ...current.stats, revision, fieldNames, fieldCount: fieldNames.length, fieldSettings, fieldSettingsRevision: fieldConfig?.revision || 'none', originalQuestionCount: parsed.items.length, deletedCount: parsed.items.length - records.length, approvedCount, pendingCount: records.length - approvedCount, expertAdviceCount: summaries.filter(item => item.expertAdvice).length }, summaries, records, expertReviews };
  }
  function expertView(view) {
    const summaries = view.summaries.map(summary => {
      const review = view.expertReviews.get(summary.number); const latest = review?.submissions.at(-1);
      return { ...summary, searchText: summary.searchText + '\n' + (review?.draft?.text.toLowerCase() || ''), expertRevision: review?.revision || 'none', expertStatus: review?.draft ? 'draft' : latest ? 'submitted' : 'unsubmitted', draftOutdated: !!review?.draft && review.draft.questionRevision !== summary.revision };
    });
    return { ...view, isExpert: true, summaries, dataset: { ...view.dataset, expertDraftCount: summaries.filter(item => item.expertStatus === 'draft').length, expertUnsubmittedCount: summaries.filter(item => item.expertStatus === 'unsubmitted').length } };
  }
  function question(view, number) {
    const index = view.summaries.findIndex(item => item.number === number);
    if (index < 0) throw new RequestError('QUESTION_NOT_FOUND', '此题不存在或已删除，请刷新列表。', 404);
    const { searchText, ...summary } = view.summaries[index];
    const review = view.expertReviews?.get(number); const latest = review?.submissions.at(-1);
    const history = review ? [...review.submissions].reverse().map(item => ({ ...item, isCurrent: item.questionRevision === summary.revision })) : [];
    const extra = view.isExpert ? { expertReview: { revision: review?.revision || 'none', draft: review?.draft || null, submitted: history[0] || null, history } } : view.expertReviews ? { expertAdvice: latest ? { ...history[0], history } : null } : {};
    return { dataset: view.dataset, summary, record: view.records[index], ...extra, navigation: { previous: view.summaries[index - 1]?.number ?? null, next: view.summaries[index + 1]?.number ?? null, position: index + 1, total: view.summaries.length } };
  }
  function requireRevision(body, summary) {
    if (!body.revision || body.revision !== summary.revision) throw new RequestError('QUESTION_CONFLICT', '此题已在其他页面修改或删除，请重新打开详情后再操作。', 409);
  }
  function integer(value, fallback, maximum = 100000) {
    if (value === null) return fallback;
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw new RequestError('INVALID_PAGE', '页码或每页条数无效。');
    return Number(value);
  }
  function filterQuestions(view, url, allowStatus = true) {
    const query = (url.searchParams.get('query') || '').trim().toLowerCase();
    const difficulty = url.searchParams.get('difficulty') || ''; const family = url.searchParams.get('family') || '';
    const issues = url.searchParams.get('issues') || ''; const status = url.searchParams.get('status') || '';
    const advice = url.searchParams.get('advice') || ''; const expertStatus = url.searchParams.get('expertStatus') || '';
    if (query.length > 300 || difficulty.length > 100 || family.length > 100 || !['', 'missing'].includes(issues) || !['', 'pending', 'approved'].includes(status) || (!allowStatus && status) || !['', 'with', 'without', 'outdated'].includes(advice) || !['', 'draft', 'submitted', 'unsubmitted'].includes(expertStatus) || (expertStatus && !view.isExpert)) throw new RequestError('INVALID_FILTER', '搜索或筛选参数无效。');
    let fieldFilters = [];
    if (url.searchParams.has('fieldFilters')) {
      const raw = url.searchParams.get('fieldFilters');
      try { fieldFilters = JSON.parse(raw); } catch { throw new RequestError('INVALID_FIELD_FILTER', '字段分类筛选格式无效，请重新选择。'); }
      const enabled = new Set((view.dataset.fieldSettings || []).filter(field => field.filterable).map(field => field.key));
      const invalid = () => new RequestError('INVALID_FIELD_FILTER', '字段未启用分类筛选或选项无效，请清除筛选后重新选择。');
      if (raw.length > 20000 || !Array.isArray(fieldFilters) || fieldFilters.length > 100) throw invalid();
      fieldFilters = fieldFilters.map(item => {
        if (!item || typeof item.key !== 'string' || !enabled.has(item.key) || Object.hasOwn(item, 'values') && Object.hasOwn(item, 'value')) throw invalid();
        const values = Object.hasOwn(item, 'values') ? item.values : [item.value];
        if (!Array.isArray(values) || !values.length || values.length > 10000 || values.some(value => typeof value !== 'string' || !/^(?:missing|[a-f0-9]{64})$/.test(value)) || new Set(values).size !== values.length) throw invalid();
        return { key: item.key, values: new Set(values) };
      });
      if (new Set(fieldFilters.map(item => item.key)).size !== fieldFilters.length) throw invalid();
    }
    return view.summaries.filter((item, index) => (!query || item.searchText.includes(query)) && (!difficulty || item.difficulty === difficulty) && (!family || item.family === family) && (!issues || item.issues.length) && (!status || item.status === status) && (!expertStatus || item.expertStatus === expertStatus) && (!advice || (advice === 'with' ? !!item.expertAdvice : advice === 'without' ? !item.expertAdvice : item.expertAdvice && !item.expertAdvice.isCurrent)) && fieldFilters.every(filter => filter.values.has(fieldCategory(view.records[index], filter.key).value)));
  }
  function listQuestions(view, url, allowStatus = true) {
    const filtered = filterQuestions(view, url, allowStatus);
    const pageSize = integer(url.searchParams.get('pageSize'), 20, 100); const requestedPage = integer(url.searchParams.get('page'), 1);
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize)); const page = Math.min(requestedPage, totalPages);
    const records = new Map(view.summaries.map((item, index) => [item.number, view.records[index]]));
    const questions = filtered.slice((page - 1) * pageSize, page * pageSize).map(({ searchText, ...item }) => ({ ...item, fieldPreviews: previewReviewRecord(records.get(item.number)) }));
    return { dataset: view.dataset, questions, total: filtered.length, page, pageSize, totalPages };
  }
  function versionMeta(version) {
    const revision = version.revision || createHash('sha256').update(JSON.stringify(version)).digest('hex');
    return { id: version.id, name: version.name, description: version.description, createdAt: version.createdAt, updatedAt: version.updatedAt, questionCount: version.questions.filter(item => !item.deletedAt).length, revision };
  }
  function findVersion(workflow, id) {
    const version = workflow.versions.find(item => item.id === id && !item.deletedAt);
    if (!version) throw new RequestError('VERSION_NOT_FOUND', '冻结版本不存在，请刷新后重新选择。', 404);
    return version;
  }
  function frozenView(version, workflow) {
    const entries = version.questions.flatMap((item, index) => item.deletedAt ? [] : [{ ...item, frozenNumber: index + 1 }]);
    const records = entries.map(item => item.record);
    const current = records.length ? parseRecords(records) : { summaries: [], stats: emptyStats() };
    // The first snapshot defines this version's columns, including after its removal.
    const fieldNames = Object.keys(version.questions[0]?.record || {});
    const sourceIds = new Set([version.questions[0]?.datasetId, ...entries.map(item => item.datasetId)].filter(Boolean));
    const configs = new Map((workflow.fieldConfigs || []).map(config => [config.datasetId, config]));
    const inherited = [...sourceIds].map(id => configs.get(id)).filter(Boolean);
    const configuredFields = inherited.map(config => new Map(config.fields.map(field => [field.key, field])));
    const fieldSettings = fieldNames.map(key => {
      const settings = configuredFields.map(fields => fields.get(key)).filter(Boolean);
      return { key, description: settings.find(field => field.description)?.description || '', filterable: settings.some(field => field.filterable) };
    });
    const fieldSettingsRevision = createHash('sha256').update(JSON.stringify(inherited.map(config => [config.datasetId, config.revision]))).digest('hex');
    return { dataset: { ...versionMeta(version), ...current.stats, fieldNames, fieldCount: fieldNames.length, fieldSettings, fieldSettingsRevision }, records, summaries: current.summaries.map((summary, index) => ({ ...summary, number: entries[index].frozenNumber, approvedAt: entries[index].approvedAt, origin: { datasetId: entries[index].datasetId, datasetName: entries[index].datasetName, number: entries[index].number } })) };
  }
  function submitExpertDrafts(source, store, expected) {
    const view = expertView(workingView(source.dataset, source.parsed, store));
    const available = new Map(view.summaries.map(summary => [summary.number, summary]));
    const reviews = new Map(store.expertReviews.filter(item => item.datasetId === source.dataset.id).map(item => [item.number, item]));
    const targets = [...expected].sort((a, b) => a.number - b.number).map(item => {
      const summary = available.get(item.number); const review = reviews.get(item.number);
      if (!summary || summary.revision !== item.revision) throw new RequestError('QUESTION_CONFLICT', '第 ' + item.number + ' 题已修改或删除，请重新打开核对后再提交。', 409);
      if (item.expertRevision !== (review?.revision || 'none')) throw new RequestError('EXPERT_REVIEW_CONFLICT', '第 ' + item.number + ' 题的专家建议已在其他页面更新，请重新打开后再操作。', 409);
      if (!review?.draft) throw new RequestError('EXPERT_DRAFT_REQUIRED', '第 ' + item.number + ' 题没有已保存的建议草稿，本次未提交任何建议。');
      if (review.draft.questionRevision !== summary.revision) throw new RequestError('EXPERT_DRAFT_OUTDATED', '第 ' + item.number + ' 题已修改，请重新核对题目并保存建议草稿后再提交。', 409);
      return { summary, review };
    });
    const changes = new Map(store.changes.filter(item => item.datasetId === source.dataset.id).map(item => [item.number, item]));
    const now = new Date().toISOString(); const selected = new Set(targets.map(item => item.summary.number));
    store.changes = store.changes.filter(item => item.datasetId !== source.dataset.id || !selected.has(item.number));
    for (const { summary, review } of targets) {
      const revision = randomUUID();
      store.changes.push({ ...changes.get(summary.number), datasetId: source.dataset.id, number: summary.number, revision, updatedAt: now });
      review.submissions.push({ id: randomUUID(), text: review.draft.text, submittedAt: now, questionRevision: revision, basedOnRevision: summary.revision });
      review.draft = null; review.revision = randomUUID();
    }
    return expertView(workingView(source.dataset, source.parsed, store));
  }
  const api = async (req, res, url) => {
    const frozenRoute = url.pathname.startsWith('/api/frozen-versions');
    const expertRoute = url.pathname.startsWith('/api/expert-reviews');
    if (!frozenRoute && !expertRoute && !url.pathname.startsWith('/api/technical-reviews')) return false;
    const distributionRoute = url.pathname.match(/^\/api\/(?:technical-reviews|expert-reviews|frozen-versions)\/([a-f0-9-]+)\/distribution$/);
    if (distributionRoute && req.method === 'GET') {
      const result = await serialize(async () => {
        const workflow = await readWorkflow(); let view;
        if (frozenRoute) view = frozenView(findVersion(workflow, distributionRoute[1]), workflow);
        else { const source = await locate(distributionRoute[1]); view = workingView(source.dataset, source.parsed, workflow); if (expertRoute) view = expertView(view); }
        const raw = url.searchParams.get('fields') || ''; let fields;
        try { fields = JSON.parse(raw); } catch { throw new RequestError('INVALID_DISTRIBUTION_FIELDS', '请选择一到两个已启用分类筛选的字段。'); }
        const enabled = new Set((view.dataset.fieldSettings || []).filter(field => field.filterable).map(field => field.key));
        if (raw.length > 20000 || !Array.isArray(fields) || fields.length < 1 || fields.length > 2 || fields.some(key => typeof key !== 'string' || !enabled.has(key)) || new Set(fields).size !== fields.length) throw new RequestError('INVALID_DISTRIBUTION_FIELDS', '请选择一到两个不同的、已启用分类筛选的字段。');
        const selected = new Set(filterQuestions(view, url, !frozenRoute).map(item => item.number));
        const records = view.records.filter((_, index) => selected.has(view.summaries[index].number));
        return reviewDistribution(records, fields);
      });
      json(res, 200, result); return true;
    }
    const fieldRoute = url.pathname.match(/^\/api\/(?:technical-reviews|expert-reviews|frozen-versions)\/([a-f0-9-]+)\/(fields|field-options)$/);
    if (fieldRoute && req.method === 'GET') {
      const data = await serialize(async () => {
        const workflow = await readWorkflow();
        let view;
        if (frozenRoute) view = frozenView(findVersion(workflow, fieldRoute[1]), workflow);
        else { const source = await locate(fieldRoute[1]); view = workingView(source.dataset, source.parsed, workflow); if (expertRoute) view = expertView(view); }
        if (fieldRoute[2] === 'fields') return { dataset: view.dataset, fields: describeReviewFields(view), revision: view.dataset.fieldSettingsRevision };
        const key = url.searchParams.get('field'), query = (url.searchParams.get('query') || '').trim().toLowerCase();
        if (query.length > 300 || !(view.dataset.fieldSettings || []).some(field => field.key === key && field.filterable)) throw new RequestError('INVALID_FIELD_FILTER', '此字段尚未启用分类筛选，请先在字段配置中开启。');
        return { key, ...reviewFieldOptions(view, key, query, integer(url.searchParams.get('page'), 1)) };
      });
      json(res, 200, data); return true;
    }
    if (fieldRoute && !frozenRoute && fieldRoute[2] === 'fields' && req.method === 'PUT') {
      const body = await readJson(req);
      const data = await serialize(async () => {
        const source = await locate(fieldRoute[1]); const workflow = await readWorkflow();
        const view = workingView(source.dataset, source.parsed, workflow);
        if (body.revision !== view.dataset.fieldSettingsRevision) throw new RequestError('FIELD_SETTINGS_CONFLICT', '字段配置已在其他页面修改，请重新打开字段配置后再保存。', 409);
        const keys = new Set(view.dataset.fieldNames);
        if (!Array.isArray(body.fields) || body.fields.length > keys.size || body.fields.some(field => !field || typeof field.key !== 'string' || !keys.has(field.key) || typeof field.description !== 'string' || field.description.length > 2000 || field.description.includes('\u0000') || typeof field.filterable !== 'boolean') || new Set(body.fields.map(field => field.key)).size !== body.fields.length) throw new RequestError('INVALID_FIELD_SETTINGS', '字段配置无效：请使用已识别的 key，描述最多 2,000 字，筛选选项需为开关。');
        const fields = body.fields.map(({ key, description, filterable }) => ({ key, description: description.trim(), filterable }));
        workflow.fieldConfigs = workflow.fieldConfigs.filter(item => item.datasetId !== source.dataset.id);
        workflow.fieldConfigs.push({ datasetId: source.dataset.id, revision: randomUUID(), updatedAt: new Date().toISOString(), fields });
        await atomicWrite(workflowPath, workflow);
        let current = workingView(source.dataset, source.parsed, workflow); if (expertRoute) current = expertView(current);
        return { ok: true, dataset: current.dataset, fields: describeReviewFields(current), revision: current.dataset.fieldSettingsRevision };
      });
      json(res, 200, data); return true;
    }
    const deleteDataset = url.pathname.match(/^\/api\/(?:technical-reviews|expert-reviews)\/([a-f0-9-]+)$/);
    if (deleteDataset && req.method === 'DELETE') {
      const body = await readJson(req);
      const removed = await serialize(async () => {
        const index = await readIndex(); const source = await locate(deleteDataset[1]); const workflow = await readWorkflow();
        const current = workingView(source.dataset, source.parsed, workflow).dataset;
        if (!body.revision || body.revision !== current.revision) throw new RequestError('DATASET_CONFLICT', '此评测集的题目或审核记录已更新，请取消后刷新列表，核对最新信息再删除。', 409);
        const entry = index.datasets.find(item => item.id === source.dataset.id);
        entry.deletedAt = new Date().toISOString(); await atomicWrite(indexPath, index); cache.delete(entry.id);
        return { id: current.id, name: current.name, questionCount: current.questionCount, originalQuestionCount: current.originalQuestionCount };
      });
      json(res, 200, { ok: true, dataset: removed }); return true;
    }
    if (expertRoute) {
      if (url.pathname === '/api/expert-reviews' && req.method === 'GET') {
        const datasets = await serialize(async () => {
          const index = await readIndex(); const store = await readWorkflow();
          return await Promise.all([...index.datasets].filter(item => !item.deletedAt).reverse().map(async dataset => { const source = await locate(dataset.id); return expertView(workingView(dataset, source.parsed, store)).dataset; }));
        });
        json(res, 200, { datasets, maxFileSize: MAX_SIZE }); return true;
      }
      const match = url.pathname.match(/^\/api\/expert-reviews\/([a-f0-9-]+)(?:\/(questions|selection|submit)(?:\/(\d+)(?:\/(advice|submit))?)?)?$/);
      if (match && req.method === 'GET' && !match[4] && match[2] !== 'submit') {
        const data = await serialize(async () => {
          const source = await locate(match[1]); const view = expertView(workingView(source.dataset, source.parsed, await readWorkflow()));
          if (!match[2]) return { dataset: view.dataset };
          if (match[2] === 'questions') return match[3] ? question(view, integer(match[3], 1)) : listQuestions(view, url);
          if (match[2] === 'selection' && !match[3]) return { dataset: view.dataset, questions: filterQuestions(view, url).map(({ searchText, ...summary }) => summary) };
          throw new RequestError('NOT_FOUND', '业务专家审核接口不存在。', 404);
        });
        json(res, 200, data); return true;
      }
      if (match && match[2] === 'questions' && match[3] && ((req.method === 'PUT' && match[4] === 'advice') || (req.method === 'POST' && match[4] === 'submit'))) {
        const body = await readJson(req); const number = integer(match[3], 1);
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (match[4] === 'advice' && (!text || text.length > 20000 || text.includes('\u0000'))) throw new RequestError('INVALID_EXPERT_ADVICE', '请填写专家修改建议，最多 20,000 个字符。');
        const data = await serialize(async () => {
          const source = await locate(match[1]); const store = await readWorkflow();
          if (match[4] === 'submit') {
            const next = submitExpertDrafts(source, store, [{ number, revision: body.questionRevision, expertRevision: body.expertRevision }]);
            await atomicWrite(workflowPath, store); return { ok: true, ...question(next, number) };
          }
          const current = question(expertView(workingView(source.dataset, source.parsed, store)), number);
          requireRevision({ revision: body.questionRevision }, current.summary);
          if (body.expertRevision !== current.expertReview.revision) throw new RequestError('EXPERT_REVIEW_CONFLICT', '专家建议已在其他页面更新，请重新打开题目后再保存。', 409);
          let review = store.expertReviews.find(item => item.datasetId === source.dataset.id && item.number === number);
          if (!review) { review = { datasetId: source.dataset.id, number, revision: 'none', draft: null, submissions: [] }; store.expertReviews.push(review); }
          review.revision = randomUUID(); review.draft = { text, questionRevision: current.summary.revision, updatedAt: new Date().toISOString() };
          await atomicWrite(workflowPath, store);
          return { ok: true, ...question(expertView(workingView(source.dataset, source.parsed, store)), number) };
        });
        json(res, 200, data); return true;
      }
      if (match && match[2] === 'submit' && !match[3] && req.method === 'POST') {
        const body = await readJson(req);
        if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > 10000 || body.questions.some(item => !item || !Number.isInteger(item.number) || item.number < 1 || item.number > 10000 || typeof item.revision !== 'string' || !item.revision || typeof item.expertRevision !== 'string' || !item.expertRevision) || new Set(body.questions.map(item => item.number)).size !== body.questions.length) throw new RequestError('INVALID_BATCH', '请选择不同的题目，并确认已保存建议草稿。');
        const data = await serialize(async () => {
          const source = await locate(match[1]); const store = await readWorkflow(); const view = submitExpertDrafts(source, store, body.questions);
          await atomicWrite(workflowPath, store);
          return { ok: true, affectedCount: body.questions.length, numbers: [...body.questions].map(item => item.number).sort((a, b) => a - b), dataset: view.dataset };
        });
        json(res, 200, data); return true;
      }
      throw new RequestError('NOT_FOUND', '业务专家审核接口不存在或请求方法不正确。', 404);
    }
    if (url.pathname === '/api/technical-reviews' && req.method === 'GET') {
      const datasets = await serialize(async () => {
        const store = await readIndex(); const workflow = await readWorkflow();
        return await Promise.all([...store.datasets].filter(item => !item.deletedAt).reverse().map(async dataset => { const source = await locate(dataset.id); return workingView(dataset, source.parsed, workflow).dataset; }));
      });
      json(res, 200, { datasets, maxFileSize: MAX_SIZE }); return true;
    }
    if (url.pathname === '/api/technical-reviews' && req.method === 'POST') {
      const name = url.searchParams.get('name') || '';
      if (!name.trim() || [...name].length > 240 || /[\\/\u0000-\u001f]/.test(name) || !/\.(json|jsonl)$/i.test(name)) throw new RequestError('INVALID_DATASET_FILENAME', '请选择 .json 或 .jsonl 格式的评测集文件。');
      if (!/^application\/(octet-stream|json|x-ndjson|jsonl)(?:;|$)/i.test(req.headers['content-type'] || '')) throw new RequestError('INVALID_UPLOAD_TYPE', '请通过页面选择 JSON / JSONL 评测集上传。', 415);
      if (Number(req.headers['content-length']) > MAX_SIZE) { req.resume(); throw new RequestError('DATASET_TOO_LARGE', '单个 JSON / JSONL 评测集最多 20 MB。', 413); }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_SIZE) throw new RequestError('DATASET_TOO_LARGE', '单个 JSON / JSONL 评测集最多 20 MB。', 413); chunks.push(chunk); }
      const buffer = Buffer.concat(chunks);
      let parsed;
      try { parsed = parseEvaluationDataset(buffer, { format: datasetFormat(name) }); }
      catch (error) { if (error instanceof DatasetError) throw new RequestError(error.code, error.message); throw error; }
      const id = randomUUID(); const dataset = { id, name, size, importedAt: new Date().toISOString(), format: parsed.format, ...parsed.stats };
      await mkdir(directory, { recursive: true });
      const temp = path.join(directory, id + '.upload.tmp'); const filename = path.join(directory, id + '.json'); let moved = false;
      try {
        await writeFile(temp, buffer, { flag: 'wx' }); await rename(temp, filename); moved = true;
        await serialize(async () => { await readWorkflow(); const store = await readIndex(); store.datasets.push(dataset); await atomicWrite(indexPath, store); });
      } catch (error) { await unlink(moved ? filename : temp).catch(() => {}); throw error; }
      remember(id, parsed);
      json(res, 201, { ok: true, dataset: workingView(dataset, parsed, { changes: [], versions: [] }).dataset }); return true;
    }
    if (url.pathname === '/api/frozen-versions' && req.method === 'GET') {
      const versions = await serialize(async () => [...(await readWorkflow()).versions].filter(item => !item.deletedAt).reverse().map(versionMeta));
      json(res, 200, { versions }); return true;
    }
    if (url.pathname === '/api/frozen-versions' && req.method === 'POST') {
      const body = await readJson(req);
      const name = typeof body.name === 'string' ? body.name.trim() : ''; const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!name || name.length > 80 || /[\u0000-\u001f]/.test(name)) throw new RequestError('INVALID_VERSION_NAME', '请填写版本名称，最多 80 个字符。');
      if (description.length > 500) throw new RequestError('INVALID_VERSION_DESCRIPTION', '版本说明最多 500 个字符。');
      const version = await serialize(async () => {
        const store = await readWorkflow();
        if (store.versions.some(item => !item.deletedAt && item.name.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase())) throw new RequestError('DUPLICATE_VERSION_NAME', '此版本名称已存在，请使用其他名称。', 409);
        const now = new Date().toISOString(); const version = { id: randomUUID(), name, description, createdAt: now, updatedAt: now, revision: randomUUID(), questions: [] };
        store.versions.push(version); await atomicWrite(workflowPath, store); return versionMeta(version);
      });
      json(res, 201, { ok: true, version }); return true;
    }
    const frozenMatch = url.pathname.match(/^\/api\/frozen-versions\/([a-f0-9-]+)(?:\/(questions|download)(?:\/(\d+))?)?$/);
    if (frozenMatch && req.method === 'DELETE' && frozenMatch[2] === 'questions' && frozenMatch[3]) {
      const body = await readJson(req); const number = integer(frozenMatch[3], 1);
      const removed = await serialize(async () => {
        const store = await readWorkflow(); const version = findVersion(store, frozenMatch[1]);
        const entry = version.questions[number - 1];
        if (!entry || entry.deletedAt) throw new RequestError('QUESTION_NOT_FOUND', '此冻结题目不存在或已删除，请刷新列表。', 404);
        if (!body.revision || body.revision !== versionMeta(version).revision) throw new RequestError('VERSION_CONFLICT', '此版本已更新，请取消后刷新列表，核对题目后再删除。', 409);
        const now = new Date().toISOString(); entry.deletedAt = now; version.updatedAt = now; version.revision = randomUUID();
        await atomicWrite(workflowPath, store);
        return { number, dataset: frozenView(version, store).dataset };
      });
      json(res, 200, { ok: true, ...removed }); return true;
    }
    if (frozenMatch && req.method === 'DELETE' && !frozenMatch[2]) {
      const body = await readJson(req);
      const removed = await serialize(async () => {
        const store = await readWorkflow(); const version = findVersion(store, frozenMatch[1]);
        const meta = versionMeta(version);
        if (!body.revision || body.revision !== meta.revision) throw new RequestError('VERSION_CONFLICT', '此版本已更新，请取消后刷新版本列表，核对最新题数再删除。', 409);
        version.deletedAt = new Date().toISOString(); version.revision = randomUUID();
        await atomicWrite(workflowPath, store);
        return { id: meta.id, name: meta.name, questionCount: meta.questionCount };
      });
      json(res, 200, { ok: true, version: removed }); return true;
    }
    if (frozenMatch && req.method === 'GET') {
      const { version, view } = await serialize(async () => {
        const workflow = await readWorkflow(), version = findVersion(workflow, frozenMatch[1]);
        return { version, view: frozenView(version, workflow) };
      });
      if (frozenMatch[2] === 'download' && !frozenMatch[3]) {
        const filename = version.name.replace(/[\\/\u0000-\u001f]/g, '_') + '.json';
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="dataset.json"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify(view.records, null, 2) + '\n'); return true;
      }
      if (frozenMatch[2] === 'questions' && frozenMatch[3]) json(res, 200, question(view, integer(frozenMatch[3], 1)));
      else if (frozenMatch[2] === 'questions') json(res, 200, listQuestions(view, url, false));
      else if (!frozenMatch[2]) json(res, 200, { dataset: view.dataset });
      else throw new RequestError('NOT_FOUND', '冻结版本接口不存在。', 404);
      return true;
    }
    const selectionMatch = url.pathname.match(/^\/api\/technical-reviews\/([a-f0-9-]+)\/selection$/);
    if (selectionMatch && req.method === 'GET') {
      const result = await serialize(async () => {
        const source = await locate(selectionMatch[1]); const store = await readWorkflow();
        const view = workingView(source.dataset, source.parsed, store);
        return { dataset: view.dataset, questions: filterQuestions(view, url).map(({ searchText, ...summary }) => summary) };
      });
      json(res, 200, result); return true;
    }
    const batchMatch = url.pathname.match(/^\/api\/technical-reviews\/([a-f0-9-]+)\/batch$/);
    if (batchMatch && req.method === 'POST') {
      const body = await readJson(req);
      if (!['delete', 'approve'].includes(body.action) || !Array.isArray(body.questions) || !body.questions.length || body.questions.length > 10000 ||
          body.questions.some(item => !item || !Number.isInteger(item.number) || item.number < 1 || item.number > 10000 || typeof item.revision !== 'string' || !item.revision || item.revision.length > 100) ||
          new Set(body.questions.map(item => item.number)).size !== body.questions.length) throw new RequestError('INVALID_BATCH', '请选择 1–10,000 道不同的题目，并刷新后重试。');
      const result = await serialize(async () => {
        const source = await locate(batchMatch[1]); const store = await readWorkflow(); const view = workingView(source.dataset, source.parsed, store);
        const available = new Map(view.summaries.map((summary, index) => [summary.number, { summary, record: view.records[index] }]));
        const targets = [...body.questions].sort((a, b) => a.number - b.number).map(item => {
          const target = available.get(item.number);
          if (!target || target.summary.revision !== item.revision) throw new RequestError('QUESTION_CONFLICT', '第 ' + item.number + ' 题已修改或删除，本次批量操作未执行，请刷新后重新选择。', 409);
          return target;
        });
        const now = new Date().toISOString(); let version;
        if (body.action === 'approve') {
          version = findVersion(store, body.versionId);
          const incomplete = targets.find(item => item.summary.issues.length);
          if (incomplete) throw new RequestError('INCOMPLETE_QUESTION', '第 ' + incomplete.summary.number + ' 题缺少问题或参考答案，本次未收录任何题目，请补充后重新选择。');
          const included = new Set(version.questions.filter(item => !item.deletedAt && item.datasetId === source.dataset.id).map(item => item.number));
          const repeated = targets.find(item => included.has(item.summary.number));
          if (repeated) throw new RequestError('QUESTION_ALREADY_FROZEN', '第 ' + repeated.summary.number + ' 题已收录在该版本中，本次未收录任何题目，请选择其他版本或调整勾选。', 409);
          if (versionMeta(version).questionCount + targets.length > 10000) throw new RequestError('VERSION_TOO_LARGE', '加入后将超过单个冻结版本 10,000 题的上限，本次未收录任何题目。');
          for (const target of targets) version.questions.push({ id: randomUUID(), datasetId: source.dataset.id, datasetName: source.dataset.name, number: target.summary.number, sourceRevision: target.summary.revision, approvedAt: now, record: target.record });
          version.updatedAt = now; version.revision = randomUUID();
        } else {
          const numbers = new Set(targets.map(item => item.summary.number));
          const previous = new Map(store.changes.filter(item => item.datasetId === source.dataset.id).map(item => [item.number, item]));
          store.changes = store.changes.filter(item => item.datasetId !== source.dataset.id || !numbers.has(item.number));
          for (const target of targets) store.changes.push({ ...previous.get(target.summary.number), datasetId: source.dataset.id, number: target.summary.number, revision: randomUUID(), updatedAt: now, deletedAt: now });
        }
        const dataset = workingView(source.dataset, source.parsed, store).dataset;
        await atomicWrite(workflowPath, store);
        return { ok: true, action: body.action, affectedCount: targets.length, numbers: targets.map(item => item.summary.number), dataset, ...(version ? { version: versionMeta(version) } : {}) };
      });
      json(res, 200, result); return true;
    }
    const match = url.pathname.match(/^\/api\/technical-reviews\/([a-f0-9-]+)(?:\/(questions|download)(?:\/(\d+)(?:\/(approve))?)?)?$/);
    if (match && req.method === 'GET' && !match[4]) {
      if (match[2] === 'download' && match[3]) throw new RequestError('NOT_FOUND', '技术人员审核接口不存在。', 404);
      const result = await serialize(async () => {
        const source = await locate(match[1], match[2] !== 'download');
        if (match[2] === 'download' && !match[3]) return source;
        const view = workingView(source.dataset, source.parsed, await readWorkflow());
        if (match[2] === 'questions' && match[3]) return question(view, integer(match[3], 1));
        if (match[2] === 'questions') return listQuestions(view, url);
        if (!match[2]) return { dataset: view.dataset };
        throw new RequestError('NOT_FOUND', '技术人员审核接口不存在。', 404);
      });
      if (result.filename) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': result.dataset.size, 'Content-Disposition': `attachment; filename="dataset.${datasetFormat(result.dataset.name)}"; filename*=UTF-8''${encodeURIComponent(result.dataset.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16))}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        createReadStream(result.filename).on('error', () => res.destroy()).pipe(res); return true;
      }
      json(res, 200, result); return true;
    }
    if (match?.[2] === 'questions' && match[3] && ((['PUT', 'DELETE'].includes(req.method) && !match[4]) || (req.method === 'POST' && match[4] === 'approve'))) {
      const body = await readJson(req); const number = integer(match[3], 1);
      const result = await serialize(async () => {
        const source = await locate(match[1]); const store = await readWorkflow();
        const current = question(workingView(source.dataset, source.parsed, store), number);
        requireRevision(body, current.summary);
        const now = new Date().toISOString();
        if (match[4] === 'approve') {
          const version = findVersion(store, body.versionId);
          if (current.summary.issues.length) throw new RequestError('INCOMPLETE_QUESTION', '请先补充问题和参考答案，再通过审核。');
          if (version.questions.some(item => !item.deletedAt && item.datasetId === source.dataset.id && item.number === number)) throw new RequestError('QUESTION_ALREADY_FROZEN', '此题已收录在该版本中；如需保存修改后的题目，请选择其他版本。', 409);
          if (versionMeta(version).questionCount >= 10000) throw new RequestError('VERSION_TOO_LARGE', '单个冻结版本最多收录 10,000 道题，请创建其他版本。');
          version.questions.push({ id: randomUUID(), datasetId: source.dataset.id, datasetName: source.dataset.name, number, sourceRevision: current.summary.revision, approvedAt: now, record: current.record });
          version.updatedAt = now; version.revision = randomUUID();
          await atomicWrite(workflowPath, store);
          return { ok: true, version: versionMeta(version), ...question(workingView(source.dataset, source.parsed, store), number) };
        }
        const previous = store.changes.find(item => item.datasetId === source.dataset.id && item.number === number);
        const change = { ...previous, datasetId: source.dataset.id, number, revision: randomUUID(), updatedAt: now };
        if (req.method === 'PUT') {
          if (!body.record || typeof body.record !== 'object' || Array.isArray(body.record)) throw new RequestError('INVALID_QUESTION', '题目内容必须是 JSON 对象。');
          parseRecords([body.record]); change.record = body.record;
        } else change.deletedAt = now;
        store.changes = store.changes.filter(item => item !== previous); store.changes.push(change);
        const view = workingView(source.dataset, source.parsed, store);
        await atomicWrite(workflowPath, store);
        return req.method === 'PUT' ? { ok: true, ...question(view, number) } : { ok: true, dataset: view.dataset, deletedNumber: number };
      });
      json(res, 200, result); return true;
    }
    throw new RequestError('NOT_FOUND', '审核或冻结评测集接口不存在或请求方法不正确。', 404);
  };
  api.importDataset = async (buffer, name, id = randomUUID()) => {
    const parsed = parseEvaluationDataset(buffer, { format: datasetFormat(name) });
    return serialize(async () => {
      const store = await readIndex(); const workflow = await readWorkflow();
      const existing = store.datasets.find(item => !item.deletedAt && (item.id === id || item.generationId === id));
      if (existing) { const source = await locate(existing.id); return workingView(existing, source.parsed, workflow).dataset; }
      const nextId = store.datasets.some(item => item.id === id) ? randomUUID() : id;
      const dataset = { id: nextId, generationId: id, name, size: buffer.length, importedAt: new Date().toISOString(), format: parsed.format, ...parsed.stats };
      await mkdir(directory, { recursive: true });
      const filename = path.join(directory, nextId + '.json'); const temp = filename + '.import.tmp'; let moved = false;
      try {
        await writeFile(temp, buffer, { flag: 'wx' }); await rename(temp, filename); moved = true;
        store.datasets.push(dataset); await atomicWrite(indexPath, store);
      } catch (error) { await unlink(moved ? filename : temp).catch(() => {}); throw error; }
      remember(nextId, parsed); return workingView(dataset, parsed, workflow).dataset;
    });
  };
  api.activeDatasetIds = () => serialize(async () => (await readIndex()).datasets.filter(item => !item.deletedAt).map(item => item.id));
  return api;
}
