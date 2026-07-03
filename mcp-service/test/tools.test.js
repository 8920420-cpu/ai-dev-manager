// MCP-SERVICE-001 — тесты регистрации инструментов, feature-флагов и поведения
// обработчиков (ошибки → JSON-результат, процесс не падает).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../src/tools.js';

// Фейковый MCP-реестр: захватывает имена, определения и обработчики.
function fakeServer() {
  const defs = new Map();
  const handlers = new Map();
  return {
    registerTool(name, def, handler) {
      assert.ok(def && typeof def.description === 'string', `${name}: есть описание`);
      assert.ok(def.inputSchema && typeof def.inputSchema === 'object', `${name}: есть inputSchema`);
      defs.set(name, def);
      handlers.set(name, handler);
    },
    defs,
    handlers,
  };
}

function baseConfig(over = {}) {
  return {
    projectRoot: '/proj',
    orchestratorUrl: 'http://o',
    toolsServiceUrl: 'http://t',
    orchestratorToken: '',
    port: 4190,
    requestTimeoutMs: 1000,
    enableWrite: false,
    enableDelete: false,
    enableOrchestratorMutations: false,
    ...over,
  };
}

const stubClients = {
  toolsClient: { execute: async () => ({ ok: true, data: { stub: true } }) },
  orchestratorClient: {
    get: async () => ({ ok: true, status: 200, data: { stub: true } }),
    post: async () => ({ ok: true, status: 200, data: { stub: true } }),
  },
};

test('по умолчанию (без флагов) write/delete/mutation-инструменты НЕ регистрируются', () => {
  const server = fakeServer();
  const names = registerTools(server, { config: baseConfig(), ...stubClients });
  // read-инструменты есть всегда:
  for (const n of ['project_list_dir', 'project_read_file', 'project_search_text', 'orchestrator_health', 'orchestrator_list_projects', 'orchestrator_claim_next_claude_task']) {
    assert.ok(names.includes(n), `есть ${n}`);
  }
  // закрытые флагами — отсутствуют:
  for (const n of ['project_edit_file', 'project_write_file', 'project_delete_file', 'orchestrator_release_claude_task', 'orchestrator_complete_scanner_task', 'orchestrator_complete_host_task', 'orchestrator_release_host_task']) {
    assert.ok(!names.includes(n), `нет ${n}`);
  }
});

test('MCP_ENABLE_WRITE добавляет edit/write, но не delete', () => {
  const names = registerTools(fakeServer(), { config: baseConfig({ enableWrite: true }), ...stubClients });
  assert.ok(names.includes('project_edit_file'));
  assert.ok(names.includes('project_write_file'));
  assert.ok(!names.includes('project_delete_file'));
});

test('MCP_ENABLE_DELETE добавляет delete', () => {
  const names = registerTools(fakeServer(), { config: baseConfig({ enableDelete: true }), ...stubClients });
  assert.ok(names.includes('project_delete_file'));
});

test('MCP_ENABLE_ORCHESTRATOR_MUTATIONS добавляет release/complete/create-инструменты', () => {
  const names = registerTools(fakeServer(), { config: baseConfig({ enableOrchestratorMutations: true }), ...stubClients });
  for (const n of ['orchestrator_create_task', 'orchestrator_release_claude_task', 'orchestrator_complete_scanner_task', 'orchestrator_complete_host_task', 'orchestrator_release_host_task']) {
    assert.ok(names.includes(n), `есть ${n}`);
  }
});

test('orchestrator_create_task без mutation-флага НЕ регистрируется', () => {
  const names = registerTools(fakeServer(), { config: baseConfig(), ...stubClients });
  assert.ok(!names.includes('orchestrator_create_task'));
});

test('orchestrator_create_task шлёт POST /api/scanner/task-intake с payload задачи', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: { accepted: true, imported: true, taskId: 't1' } }; },
    },
  });
  const out = await server.handlers.get('orchestrator_create_task')({
    externalId: 'codex-1', project: 'PS', title: 'Новая задача', description: 'сырой запрос',
  });
  assert.equal(seen.path, '/api/scanner/task-intake');
  assert.equal(seen.body.externalId, 'codex-1');
  assert.equal(seen.body.project, 'PS');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.taskId, 't1');
  assert.ok(!out.isError);
});

test('файловый инструмент подставляет root из конфигурации', async () => {
  let seenArgs;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: { execute: async (tool, args) => { seenArgs = { tool, args }; return { ok: true, data: {} }; } },
    orchestratorClient: stubClients.orchestratorClient,
  });
  await server.handlers.get('project_read_file')({ path: 'a.txt' });
  assert.equal(seenArgs.tool, 'read_file');
  assert.equal(seenArgs.args.root, '/proj');
  assert.equal(seenArgs.args.path, 'a.txt');
});

test('успешный обработчик возвращает text content с JSON', async () => {
  const server = fakeServer();
  registerTools(server, { config: baseConfig(), ...stubClients });
  const out = await server.handlers.get('orchestrator_health')({});
  assert.equal(out.content[0].type, 'text');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.ok, true);
  assert.ok(!out.isError);
});

test('ошибка клиента → JSON-результат с isError, без выброса исключения', async () => {
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: { get: async () => ({ ok: false, status: 500, code: 'http_error', error: 'boom' }), post: async () => ({ ok: true }) },
  });
  const out = await server.handlers.get('orchestrator_health')({});
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'boom');
});

test('исключение внутри клиента перехватывается и не валит процесс', async () => {
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: { get: async () => { throw new Error('unexpected'); }, post: async () => ({}) },
  });
  const out = await server.handlers.get('orchestrator_list_projects')({});
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.code, 'internal_error');
});

test('MCP-роли: read-only инструменты list/get регистрируются всегда', () => {
  const names = registerTools(fakeServer(), { config: baseConfig(), ...stubClients });
  assert.ok(names.includes('orchestrator_list_mcp_roles'));
  assert.ok(names.includes('orchestrator_get_mcp_role'));
});

test('orchestrator_get_mcp_role шлёт GET /api/mcp-roles/:code с кодом роли', async () => {
  let seenPath;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path) => { seenPath = path; return { ok: true, status: 200, data: { code: 'MCP_REVIEWER', prompt: 'p', requirements: 'r' } }; },
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_get_mcp_role')({ roleCode: 'MCP_REVIEWER' });
  assert.equal(seenPath, '/api/mcp-roles/MCP_REVIEWER');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.data.requirements, 'r');
  assert.ok(!out.isError);
});

test('orchestrator_get_project_stages извлекает stages из карточки проекта', async () => {
  let seenPath;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path) => { seenPath = path; return { ok: true, status: 200, data: { id: 'p1', stages: [{ code: 'CODING' }] } }; },
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_get_project_stages')({ projectId: 'p1' });
  assert.equal(seenPath, '/api/projects/p1');
  const parsed = JSON.parse(out.content[0].text);
  assert.deepEqual(parsed.data.stages, [{ code: 'CODING' }]);
});
