import { fieldCategory } from './review-fields.mjs';

export function reviewDistribution(records, fields) {
  const axes = fields.map(key => ({ key, categories: new Map() }));
  const pairs = new Map();
  for (const record of records) {
    const values = axes.map(axis => {
      const category = fieldCategory(record, axis.key);
      if (!axis.categories.has(category.value)) axis.categories.set(category.value, { ...category, count: 0 });
      axis.categories.get(category.value).count++;
      return category.value;
    });
    if (fields.length === 2) {
      const token = values.join(':');
      if (!pairs.has(token)) pairs.set(token, { row: values[0], column: values[1], count: 0 });
      pairs.get(token).count++;
    }
  }
  const total = records.length;
  const percentage = count => total ? count / total * 100 : 0;
  return {
    fields, total,
    axes: axes.map(axis => ({ key: axis.key, categories: [...axis.categories.values()].map(category => ({ ...category, label: category.label.slice(0, 160), truncated: category.label.length > 160, percentage: percentage(category.count) })) })),
    // Sparse pairs keep a 10,000 × 10,000 category matrix bounded by the question count.
    ...(fields.length === 2 ? { cells: [...pairs.values()].map(cell => ({ ...cell, percentage: percentage(cell.count) })) } : {})
  };
}
