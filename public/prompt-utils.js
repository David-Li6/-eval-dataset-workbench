// Shared by the library UI and API; templates are plain text, never executable code.
const pattern = () => /\{\{\s*([\p{L}\p{N}_.-]{1,50})\s*\}\}/gu;

export function extractVariables(content) {
  return [...new Set([...String(content).matchAll(pattern())].map(match => match[1]))];
}

export function renderTemplate(content, values = {}) {
  const variables = extractVariables(content);
  const valid = name => Object.hasOwn(values, name) && typeof values[name] === 'string' && values[name].trim() !== '';
  const missingVariables = variables.filter(name => !valid(name));
  const text = String(content).replace(pattern(), (original, name) => valid(name) ? values[name] : original);
  return { text, missingVariables };
}
