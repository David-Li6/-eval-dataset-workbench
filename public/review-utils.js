export const reviewFields = [
  { key: 'Question', label: '完整题面', aliases: ['Question', '问题', '题目', '题干', 'prompt', 'instruction'] },
  { key: 'User Question', label: '用户提问', aliases: ['User Question', '用户问题', '用户提问', '自然问题'] },
  { key: 'SELECT Data', label: '查询数据', aliases: ['SELECT Data', '查询数据', '补充数据', '背景数据'] },
  { key: 'answer', label: '参考答案', aliases: ['answer', '答案', '参考答案', '标准答案', 'expected_answer', 'reference_answer', 'output', 'response'] },
  { key: 'Scoring criteria', label: '评分标准', aliases: ['Scoring criteria', '得分标准', '评分标准', '评分细则', 'rubric'] },
  { key: 'difficulty', label: '难度', aliases: ['difficulty', '难度'] },
  { key: 'Task family', label: '任务族', aliases: ['Task family', '任务族', '任务类型', '题型'] },
  { key: 'source', label: '来源', aliases: ['source', '来源', '来源题目ID', '来源ID'] },
  { key: 'id', label: '题目编号', aliases: ['id', '题目ID', 'question_id', '编号'] }
];

export const normalizeFieldName = value => String(value).normalize('NFKC').toLowerCase().replace(/[\s_-]/g, '');

export function identifyReviewFields(record) {
  const keys = new Map();
  for (const key of Object.keys(record)) if (!keys.has(normalizeFieldName(key))) keys.set(normalizeFieldName(key), key);
  const identified = Object.create(null);
  for (const field of reviewFields) {
    for (const alias of field.aliases) {
      const found = keys.get(normalizeFieldName(alias));
      if (found !== undefined) { identified[field.key] = found; break; }
    }
  }
  return identified;
}

export function orderedReviewFields(record) {
  const identified = identifyReviewFields(record);
  const selected = new Set();
  const result = [];
  for (const field of reviewFields) {
    const key = identified[field.key];
    if (key !== undefined && !selected.has(key)) { result.push({ key, label: field.label }); selected.add(key); }
  }
  for (const key of Object.keys(record)) if (!selected.has(key)) result.push({ key, label: '其他字段' });
  return result;
}
