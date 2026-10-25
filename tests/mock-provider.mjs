// Development-only fixture; never used by the application itself.
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Mock endpoint not found' } }));
  }
  if (body.model === 'mock-auth-failure') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Invalid API Key: ${req.headers.authorization || 'missing'}` } }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  if (body.model === 'mock-empty') return res.end(JSON.stringify({ choices: [] }));
  setTimeout(() => res.end(JSON.stringify({ model: 'mock-success', choices: [{ message: { role: 'assistant', content: '连接成功（本地测试接口）' } }], usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 } })), 700);
});

server.listen(18876, '127.0.0.1', () => console.log('Local test fixture: http://127.0.0.1:18876/v1'));
