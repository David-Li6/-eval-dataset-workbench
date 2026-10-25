import { identifyReviewFields, normalizeFieldName } from './public/review-utils.js';

export class DatasetError extends Error {
  constructor(message, code = 'INVALID_DATASET') { super(message); this.code = code; }
}
const wrapperNames = new Set(['data', 'items', 'questions', 'records', 'dataset', 'evalset', 'evaluationset', 'testcases', '评测集', '题目']);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasValue = value => value != null && !(typeof value === 'string' && !value.trim());
const display = (value, limit = 300) => value == null ? '' : (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, limit);

export function previewReviewRecord(record) {
  const fields = identifyReviewFields(record);
  const primary = fields['User Question'] !== undefined && hasValue(record[fields['User Question']]) ? fields['User Question'] : fields.Question;
  return Object.entries(record).map(([key, value], index) => {
    const text = typeof value === 'string' ? value || '""' : JSON.stringify(value);
    return { key, text: text.slice(0, 600), truncated: text.length > 600, kind: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      isQuestion: key === fields.Question || key === fields['User Question'], isPrimary: primary === key || primary === undefined && index === 0 };
  });
}

function findRecords(root) {
  if (Array.isArray(root)) return { items: root, format: '顶层数组' };
  if (!isObject(root)) throw new DatasetError('评测集需要是 JSON 题目数组，或包含题目数组的对象。');
  const fields = identifyReviewFields(root);
  if (fields.Question !== undefined || fields['User Question'] !== undefined) return { items: [root], format: '单题对象' };
  const candidates = [];
  function visit(value, path, depth) {
    for (const key of Object.keys(value)) {
      if (!wrapperNames.has(normalizeFieldName(key))) continue;
      const entry = value[key];
      const current = path ? path + '.' + key : key;
      if (Array.isArray(entry)) candidates.push({ items: entry, format: current + ' 数组' });
      else if (isObject(entry) && depth < 3) visit(entry, current, depth + 1);
    }
  }
  visit(root, '', 0);
  if (candidates.length > 1) throw new DatasetError('发现多个可能的题目数组，请只保留一个，或将题目数组直接放在 JSON 顶层。', 'AMBIGUOUS_DATASET');
  if (!candidates.length) throw new DatasetError('未找到题目数组。支持顶层数组，以及 data、questions、items、records、dataset 等常见字段。');
  return candidates[0];
}
function validateDepth(value) {
  const stack = [[value, 0]];
  while (stack.length) {
    const [entry, depth] = stack.pop();
    if (depth > 70) throw new DatasetError('JSON 嵌套层级过深，请整理后再上传。', 'DATASET_TOO_DEEP');
    if (entry && typeof entry === 'object') for (const item of Object.values(entry)) if (item && typeof item === 'object') stack.push([item, depth + 1]);
  }
}

function readJsonLines(text) {
  const items = [];
  const lines = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const lineNumber = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new DatasetError('JSONL 第 ' + lineNumber + ' 行语法有误，本次未导入。请确保每行是一个完整的 JSON 对象，且行尾没有多余逗号。', 'INVALID_DATASET_JSON'); }
    if (!isObject(record)) throw new DatasetError('JSONL 第 ' + lineNumber + ' 行不是 JSON 对象，本次未导入。请按每行一道题保存，不要使用外层数组。', 'INVALID_QUESTION_RECORD');
    try { validateDepth([record]); }
    catch (error) { if (error instanceof DatasetError) throw new DatasetError('JSONL 第 ' + lineNumber + ' 行：' + error.message, error.code); throw error; }
    items.push(record);
    if (items.length > 10000) throw new DatasetError('单个评测集最多支持 10,000 道题，请拆分后上传。', 'TOO_MANY_QUESTIONS');
  }
  return { items, format: 'JSONL（每行一题）' };
}

export function parseEvaluationDataset(buffer, { format: inputFormat = 'json' } = {}) {
  let text;
  try {
    const encoding = buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8';
    text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
  } catch { throw new DatasetError('文件编码无法识别，请将 JSON / JSONL 保存为 UTF-8 编码后上传。', 'INVALID_DATASET_ENCODING'); }
  let records;
  if (inputFormat === 'jsonl') records = readJsonLines(text);
  else {
    let root;
    try { root = JSON.parse(text); }
    catch (error) {
      const location = error.message.match(/line (\d+) column (\d+)/i);
      throw new DatasetError('JSON 语法有误' + (location ? '，请检查第 ' + location[1] + ' 行、第 ' + location[2] + ' 列附近的逗号、引号或括号。' : '，请检查逗号、引号和括号是否正确。'), 'INVALID_DATASET_JSON');
    }
    validateDepth(root);
    records = findRecords(root);
  }
  const { items, format } = records;
  if (!items.length) throw new DatasetError('评测集为空，至少需要一条题目记录。', 'EMPTY_DATASET');
  if (items.length > 10000) throw new DatasetError('单个评测集最多支持 10,000 道题，请拆分后上传。', 'TOO_MANY_QUESTIONS');
  const fieldNames = new Set();
  const difficulties = new Map();
  const families = new Map();
  const summaries = items.map((record, index) => {
    if (!isObject(record)) throw new DatasetError('第 ' + (index + 1) + ' 条记录不是 JSON 对象，本次未导入，请修正后重试。', 'INVALID_QUESTION_RECORD');
    for (const key of Object.keys(record)) fieldNames.add(key);
    const identified = identifyReviewFields(record);
    const value = canonical => identified[canonical] === undefined ? undefined : record[identified[canonical]];
    const question = hasValue(value('User Question')) ? value('User Question') : value('Question');
    const difficulty = display(value('difficulty'), 100) || '未标注';
    const family = display(value('Task family'), 100) || '未标注';
    const issues = [];
    if (!hasValue(question)) issues.push('未识别到问题字段或问题为空');
    if (!hasValue(value('answer'))) issues.push('未识别到参考答案或答案为空');
    difficulties.set(difficulty, (difficulties.get(difficulty) || 0) + 1);
    families.set(family, (families.get(family) || 0) + 1);
    return {
      number: index + 1,
      question: hasValue(question) ? display(question, 300) : '未识别到问题，请打开详情查看',
      recordId: display(value('id'), 120), source: display(value('source'), 300), difficulty, family, issues,
      searchText: Object.entries(record).map(([key, entry]) => key + '\n' + display(entry, 100000)).join('\n').toLowerCase()
    };
  });
  return { items, summaries, format, stats: { questionCount: items.length, issueCount: summaries.filter(item => item.issues.length).length, fieldNames: [...fieldNames], fieldCount: fieldNames.size, difficulties: Object.fromEntries(difficulties), families: Object.fromEntries(families) } };
}
