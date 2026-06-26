// MCP-SERVICE-001 — тесты конфигурации и парсинга флагов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, truthy } from '../src/config.js';

test('truthy распознаёт 1/true/yes/on и отвергает остальное', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' On ']) assert.equal(truthy(v), true, `${v} → true`);
  for (const v of ['0', 'false', '', undefined, null, 'no', 'off', '2']) assert.equal(truthy(v), false, `${v} → false`);
});

test('loadConfig: значения по умолчанию для локального запуска', () => {
  const c = loadConfig({});
  assert.equal(c.orchestratorUrl, 'http://localhost:4186');
  assert.equal(c.toolsServiceUrl, 'http://localhost:4188');
  assert.equal(c.port, 4190);
  assert.equal(c.enableWrite, false);
  assert.equal(c.enableDelete, false);
  assert.equal(c.enableOrchestratorMutations, false);
  assert.ok(c.requestTimeoutMs >= 1000);
});

test('loadConfig: флаги и обрезка хвостовых слэшей в URL', () => {
  const c = loadConfig({
    PROJECT_ROOT: '/workspace',
    ORCHESTRATOR_URL: 'http://orchestrator-service:4186/',
    TOOLS_SERVICE_URL: 'http://tools-service:4188///',
    ORCHESTRATOR_API_TOKEN: 'secret',
    MCP_SERVICE_PORT: '4190',
    MCP_ENABLE_WRITE: '1',
    MCP_ENABLE_DELETE: 'true',
    MCP_ENABLE_ORCHESTRATOR_MUTATIONS: 'yes',
  });
  assert.equal(c.projectRoot, '/workspace');
  assert.equal(c.orchestratorUrl, 'http://orchestrator-service:4186');
  assert.equal(c.toolsServiceUrl, 'http://tools-service:4188');
  assert.equal(c.orchestratorToken, 'secret');
  assert.equal(c.enableWrite, true);
  assert.equal(c.enableDelete, true);
  assert.equal(c.enableOrchestratorMutations, true);
});
