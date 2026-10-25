// Isolated UI fixture: local model simulator and temporary data only.
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAppServer } from '../server.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const directory = await mkdtemp(path.join(project, 'test-results', 'generation-ui-'));
let serial = 0;
const model = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const input = JSON.parse(raw), prompt = input.messages[1].content;
  const count = Number(prompt.match(/本批必须生成 (\d+) 道题/)[1]);
  const refs = [...new Set([...prompt.matchAll(/\[(SRC-\d+)\]/g)].map(match => match[1]))];
  const records = Array.from({ length: count }, (_, index) => {
    const number = ++serial;
    return { Question: '根据模拟报价记录回答第 ' + number + ' 个价格查询问题。', 'User Question': '8月' + (18 + number) + '日演示地点甲演示商品A多少钱？', 'SELECT Data': { 数据性质: '浏览器验收模拟数据', 日期: '2026-08-' + (18 + number), 地点: '演示地点甲', 品名: '演示商品A', 报价: 685, 单位: '元/吨', 口径: '含税' }, answer: '当日演示地点甲演示商品A报价为685元/吨，含税。', 'Scoring criteria': { 满分: 5, 得分点: [{ 分值: 3, 标准: '价格685准确' }, { 分值: 2, 标准: '说明元/吨及含税口径' }] }, difficulty: '易', 'Task family': 'A 点查', source: 'IO-001（' + refs[index % refs.length] + '）' };
  });
  await new Promise(resolve => setTimeout(resolve, 700));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(records) } }] }));
});
await new Promise(resolve => model.listen(18878, '127.0.0.1', resolve));
const app = createAppServer({ configPath: path.join(directory, 'config.json') });
await new Promise(resolve => app.listen(18879, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:18879';
async function post(route, body) {
  const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
await post('/api/providers', { name: '验收模拟模型', baseUrl: 'http://127.0.0.1:18878/v1', models: ['mock-eval-model'], timeoutSeconds: 60 });
await post('/api/prompts', { name: '专家口径评测题模板', category: '题目生成', content: '请针对{{领域}}，参考{{参考资料}}，生成{{题目数量}}道评测题，保持专家要求的日期、价格、单位和含税口径。' });
for (const [name, text] of [['虚构业务原题.csv', '题目id,问题,专家结论/意见\nIO-001,演示地点甲演示商品A价格是多少,回答报价并注明元/吨含税\n'], ['专家补充意见.md', '# 价格口径\n所有报价请明确时间、地点、规格、单位和含税条件。']]) {
  const response = await fetch(url + '/api/files?name=' + encodeURIComponent(name), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: text });
  if (!response.ok) throw new Error(await response.text());
}
console.log('Isolated generation UI: ' + url + '/files');
console.log('Fixture data: ' + directory);
process.on('SIGINT', () => { app.closeAllConnections(); app.close(); model.closeAllConnections(); model.close(); });
