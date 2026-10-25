// Isolated browser test server. Never reads or changes real provider configuration.
import './mock-provider.mjs';
import { createAppServer } from '../server.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = createAppServer({ configPath: path.join(project, 'test-results', 'ui-fixture', 'config.json') });
app.listen(18877, '127.0.0.1', () => console.log('Isolated UI test: http://127.0.0.1:18877'));
