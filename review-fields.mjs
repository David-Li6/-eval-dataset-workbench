import { createHash } from 'node:crypto';

const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const canonical = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
export function fieldCategory(record, key) {
  if (!Object.hasOwn(record, key)) return { value: 'missing', type: 'missing', label: '字段缺失' };
  const raw = record[key], type = typeOf(raw), serialized = canonical(raw);
  return { value: createHash('sha256').update(type + ':' + serialized).digest('hex'), type, label: type === 'string' ? raw || '空字符串' : serialized };
}
export function describeReviewFields(view) {
  const saved = new Map((view.dataset.fieldSettings || []).map(field => [field.key, field]));
  const stats = new Map(view.dataset.fieldNames.map(key => [key, { types: new Set(), values: new Set(), present: 0 }]));
  for (const record of view.records) for (const key of Object.keys(record)) {
    const stat = stats.get(key); if (!stat) continue;
    const category = fieldCategory(record, key); stat.types.add(category.type); stat.values.add(category.value); stat.present += 1;
  }
  return view.dataset.fieldNames.map(key => {
    const stat = stats.get(key), missingCount = view.records.length - stat.present;
    return { key, description: saved.get(key)?.description || '', filterable: saved.get(key)?.filterable || false, types: [...stat.types], categoryCount: stat.values.size + (missingCount ? 1 : 0), missingCount };
  });
}
export function reviewFieldOptions(view, key, query = '', requestedPage = 1) {
  const categories = new Map();
  for (const record of view.records) {
    const option = fieldCategory(record, key);
    if (!categories.has(option.value)) categories.set(option.value, { ...option, count: 0 });
    categories.get(option.value).count += 1;
  }
  const matches = [...categories.values()].filter(item => !query || item.label.toLowerCase().includes(query));
  matches.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN') || a.value.localeCompare(b.value));
  const totalPages = Math.max(1, Math.ceil(matches.length / 100)), page = Math.min(requestedPage, totalPages);
  return { options: matches.slice((page - 1) * 100, page * 100).map(item => ({ ...item, label: item.label.slice(0, 160), truncated: item.label.length > 160 })), page, totalPages, total: matches.length, totalCategories: categories.size };
}
