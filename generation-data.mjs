import { parseEvaluationDataset } from './review-data.mjs';
import { identifyReviewFields } from './public/review-utils.js';
import { generationFields } from './public/generation-utils.js';

export function createGenerationPlan(units, count, batchSize) {
  const chunks = []; let current = [], size = 0;
  for (const unit of units) {
    if (current.length && size + unit.text.length > 18000) { chunks.push(current); current = []; size = 0; }
    current.push(unit); size += unit.text.length;
  }
  if (current.length) chunks.push(current);
  if (!chunks.length) throw new Error('所选文件中没有可生成题目的内容。');
  // The user's question count and batch size determine generation requests.
  // Source chunks are distributed or sampled independently to keep prompts bounded.
  const batches = Math.ceil(count / batchSize);
  return Array.from({ length: batches }, (_, index) => {
    const sourceIndex = chunks.length > batches
      ? batches === 1 ? Math.floor((chunks.length - 1) / 2) : Math.round(index * (chunks.length - 1) / (batches - 1))
      : Math.floor(index * chunks.length / batches);
    return { units: chunks[sourceIndex], count: Math.min(batchSize, count - index * batchSize) };
  });
}
export const questionFingerprint = record => record['User Question'].normalize('NFKC').replace(/\s+/g, '').toLowerCase();
export function validateGeneratedBatch(raw, count, refs, previous = []) {
  const text = raw.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1');
  const parsed = parseEvaluationDataset(Buffer.from(text));
  if (parsed.items.length !== count) throw new Error('本批需要 ' + count + ' 道题，模型实际返回 ' + parsed.items.length + ' 道。');
  const seen = new Set(previous.map(questionFingerprint));
  return parsed.items.map((record, index) => {
    const identified = identifyReviewFields(record); const result = {};
    for (const field of generationFields) {
      if (identified[field] === undefined) throw new Error('第 ' + (index + 1) + ' 题缺少字段“' + field + '”。');
      result[field] = record[identified[field]];
    }
    for (const field of ['Question', 'User Question', 'answer', 'difficulty', 'Task family', 'source']) if (typeof result[field] !== 'string' || !result[field].trim()) throw new Error('第 ' + (index + 1) + ' 题的“' + field + '”需要是非空文字。');
    if (!['string', 'object'].includes(typeof result['Scoring criteria']) || result['Scoring criteria'] == null || !JSON.stringify(result['Scoring criteria']).replace(/[\s"\[\]{}]/g, '')) throw new Error('第 ' + (index + 1) + ' 题缺少有效评分标准。');
    const citations = result.source.match(/SRC-\d{4,}/g) || [];
    if (!citations.length || citations.some(ref => !refs.has(ref))) throw new Error('第 ' + (index + 1) + ' 题的 source 未引用当前材料中的有效 SRC 编号。');
    const fingerprint = questionFingerprint(result);
    if (seen.has(fingerprint)) throw new Error('模型返回了重复的用户问题，请继续生成以重试本批。');
    seen.add(fingerprint); return result;
  });
}
