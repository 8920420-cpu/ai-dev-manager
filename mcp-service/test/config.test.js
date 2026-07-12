// MCP-SERVICE-001 — тесты конфигурации и парсинга флагов.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  truthy,
  parseEnv,
  loadEnvFile,
  resolveEnv,
  checkConfig,
} from '../src/config.js';

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
  assert.equal(c.allowInsecureLocal, false);
  assert.ok(c.requestTimeoutMs >= 1000);
  assert.equal(c.bodyLimitBytes, 1048576);
});

test('loadConfig: MCP_BODY_LIMIT_BYTES переопределяет лимит тела', () => {
  assert.equal(loadConfig({ MCP_BODY_LIMIT_BYTES: '2048' }).bodyLimitBytes, 2048);
  // Слишком маленькое значение поднимается до минимума 1024.
  assert.equal(loadConfig({ MCP_BODY_LIMIT_BYTES: '10' }).bodyLimitBytes, 1024);
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
    ALLOW_INSECURE_LOCAL: '1',
  });
  assert.equal(c.projectRoot, '/workspace');
  assert.equal(c.orchestratorUrl, 'http://orchestrator-service:4186');
  assert.equal(c.toolsServiceUrl, 'http://tools-service:4188');
  assert.equal(c.orchestratorToken, 'secret');
  assert.equal(c.enableWrite, true);
  assert.equal(c.enableDelete, true);
  assert.equal(c.enableOrchestratorMutations, true);
  assert.equal(c.allowInsecureLocal, true);
});

// ─────────────────── MCP-TOKEN-SYNC-001: .env как единый источник ───────────────────

test('parseEnv: KEY=VALUE, комментарии, export, кавычки', () => {
  const parsed = parseEnv(
    [
      '# комментарий',
      '',
      'ORCHESTRATOR_API_TOKEN=secret-token',
      'export ORCHESTRATOR_URL="http://orchestrator-service:4186"',
      "PROJECT_ROOT='ai-dev-manager'",
      'BROKEN LINE WITHOUT EQ',
      '=novalue',
      '  SPACED  =  value  ',
    ].join('\n'),
  );
  assert.equal(parsed.ORCHESTRATOR_API_TOKEN, 'secret-token');
  assert.equal(parsed.ORCHESTRATOR_URL, 'http://orchestrator-service:4186');
  assert.equal(parsed.PROJECT_ROOT, 'ai-dev-manager');
  assert.equal(parsed.SPACED, 'value');
  assert.ok(!('BROKEN LINE WITHOUT EQ' in parsed));
});

test('loadEnvFile: отсутствие файла — не ошибка, а {}', () => {
  const readFail = () => {
    throw new Error('ENOENT');
  };
  assert.deepEqual(loadEnvFile('/нет/такого/.env', readFail), {});
});

test('resolveEnv: process.env имеет приоритет над .env, недостающее добирается из файла', () => {
  const fileVals = 'ORCHESTRATOR_API_TOKEN=from-file\nORCHESTRATOR_URL=http://from-file:4186\n';
  const readFile = () => fileVals;
  // process.env задаёт URL, но НЕ токен — токен добирается из .env (сценарий Codex).
  const env = resolveEnv(
    { ORCHESTRATOR_URL: 'http://from-env:4186', MCP_ENV_FILE: '/x/.env' },
    { readFile },
  );
  assert.equal(env.ORCHESTRATOR_URL, 'http://from-env:4186'); // process.env выигрывает
  assert.equal(env.ORCHESTRATOR_API_TOKEN, 'from-file'); // добралось из .env
});

test('checkConfig: мутации без токена → ошибка согласованности (без значения токена)', () => {
  const check = checkConfig(loadConfig({ MCP_ENABLE_ORCHESTRATOR_MUTATIONS: '1' }));
  assert.equal(check.ok, false);
  assert.equal(check.tokenConfigured, false);
  assert.equal(check.mutationsEnabled, true);
  assert.ok(check.problems.some((p) => p.code === 'mutations_without_token'));
  // Диагностика не должна раскрывать значение токена.
  assert.ok(!JSON.stringify(check).includes('secret'));
});

test('checkConfig: мутации с токеном → согласовано', () => {
  const check = checkConfig(
    loadConfig({ MCP_ENABLE_ORCHESTRATOR_MUTATIONS: '1', ORCHESTRATOR_API_TOKEN: 'secret' }),
  );
  assert.equal(check.ok, true);
  assert.equal(check.tokenConfigured, true);
  assert.deepEqual(check.problems, []);
});

test('checkConfig: мутации без токена, но ALLOW_INSECURE_LOCAL=1 → согласовано', () => {
  const check = checkConfig(
    loadConfig({ MCP_ENABLE_ORCHESTRATOR_MUTATIONS: '1', ALLOW_INSECURE_LOCAL: '1' }),
  );
  assert.equal(check.ok, true);
});
