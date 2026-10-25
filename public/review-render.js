import { orderedReviewFields } from './review-utils.js';
export function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function fieldValue(value, depth = 0) {
  if (value === null) return node('span', 'field-null', 'null');
  if (typeof value === 'string') return value.length ? node('pre', 'field-string', value) : node('span', 'field-null', '空字符串 ""');
  if (typeof value !== 'object') return node('span', 'field-primitive', String(value));
  if (!Object.keys(value).length) return node('span', 'field-null', Array.isArray(value) ? '[]' : '{}');
  if (depth >= 5 || Object.keys(value).length > 50) return node('pre', 'nested-json', JSON.stringify(value, null, 2));
  if (Array.isArray(value)) {
    const list = node('ol', 'field-array');
    for (const entry of value) { const item = node('li'); item.append(fieldValue(entry, depth + 1)); list.append(item); }
    return list;
  }
  const list = node('dl', 'field-object');
  for (const [key, entry] of Object.entries(value)) { const definition = node('dd'); definition.append(fieldValue(entry, depth + 1)); list.append(node('dt', '', key), definition); }
  return list;
}
export function renderRecord(record) {
  return orderedReviewFields(record).map(field => {
    const section = node('section', 'question-field'); const heading = node('header'); heading.append(node('strong', '', field.key), node('span', '', field.label));
    const body = node('div', 'field-body'); body.append(fieldValue(record[field.key])); section.append(heading, body); return section;
  });
}
export function renderExpertAdvice(advice) {
  const section = node('section', 'question-field expert-advice-field'); const header = node('header');
  header.append(node('strong', '', '专家建议'), node('span', '', advice ? '提交于 ' + new Date(advice.submittedAt).toLocaleString('zh-CN', { hour12: false }) : '暂无已提交建议'));
  const body = node('div', 'field-body');
  if (!advice) body.append(node('p', 'expert-advice-empty', '业务专家尚未提交修改建议。'));
  else {
    if (!advice.isCurrent) body.append(node('p', 'expert-advice-outdated', '此题在建议提交后已修改，请结合当前内容核对。'));
    body.append(node('pre', 'field-string', advice.text));
    if (advice.history.length > 1) {
      const details = node('details', 'expert-advice-history'); details.append(node('summary', '', '查看历史建议（' + (advice.history.length - 1) + ' 条）'));
      for (const entry of advice.history.slice(1)) { const item = node('div', 'expert-history-item'); item.append(node('small', '', new Date(entry.submittedAt).toLocaleString('zh-CN', { hour12: false })), node('pre', 'field-string', entry.text)); details.append(item); }
      body.append(details);
    }
  }
  section.append(header, body); return section;
}
