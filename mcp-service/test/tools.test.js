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
  for (const n of ['project_list_dir', 'project_read_file', 'project_search_text', 'orchestrator_health', 'orchestrator_list_projects', 'orchestrator_list_codebase_memory', 'orchestrator_get_codebase_memory', 'orchestrator_claim_next_claude_task']) {
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

test('orchestrator_create_task с intakeCompleted разворачивает entryRole=ARCHITECT и шлёт card', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: { accepted: true, taskId: 't2', toStatus: 'ARCHITECTURE' } }; },
    },
  });
  const card = { short_title: 'S', structured_description: 'D' };
  const out = await server.handlers.get('orchestrator_create_task')({
    externalId: 'mcp-1', projectPath: '/p', title: 'S', description: 'D', intakeCompleted: true, card,
  });
  assert.equal(seen.path, '/api/scanner/task-intake');
  assert.equal(seen.body.entryRole, 'ARCHITECT');
  assert.equal(seen.body.intakeCompleted, undefined); // флаг развёрнут в entryRole, в тело не идёт
  assert.deepEqual(seen.body.card, card);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.data.toStatus, 'ARCHITECTURE');
  assert.ok(!out.isError);
});

test('orchestrator_create_task без intakeCompleted НЕ добавляет entryRole', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: { accepted: true, taskId: 't3' } }; },
    },
  });
  await server.handlers.get('orchestrator_create_task')({ externalId: 'mcp-2', project: 'PS', title: 'T' });
  assert.equal(seen.body.entryRole, undefined);
  assert.equal(seen.body.intakeCompleted, undefined);
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

test('Codebase Memory MCP tools route to project memory API', async () => {
  const seen = [];
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path, options) => {
        seen.push({ path, options });
        return { ok: true, status: 200, data: { documents: [{ key: 'architecture' }] } };
      },
      post: async () => ({}),
    },
  });

  assert.ok(server.handlers.has('orchestrator_list_codebase_memory'));
  assert.ok(server.handlers.has('orchestrator_get_codebase_memory'));

  await server.handlers.get('orchestrator_list_codebase_memory')({ projectId: 'PROJECT', includeContent: true });
  await server.handlers.get('orchestrator_get_codebase_memory')({ projectId: 'PROJECT', key: 'architecture' });

  assert.equal(seen[0].path, '/api/projects/PROJECT/codebase-memory');
  assert.deepEqual(seen[0].options, { query: { includeContent: 1 } });
  assert.equal(seen[1].path, '/api/projects/PROJECT/codebase-memory/architecture');
});

// ─────────────── Инфраструктурный отдел (INFRA-DEPARTMENT-001) ───────────────

test('инфра read-only и reasoning-claim инструменты регистрируются всегда', () => {
  const names = registerTools(fakeServer(), { config: baseConfig(), ...stubClients });
  for (const n of [
    'orchestrator_list_infra_roles', 'orchestrator_get_infra_role',
    'orchestrator_list_infra_tasks', 'orchestrator_claim_next_reasoning_task',
  ]) {
    assert.ok(names.includes(n), `есть ${n}`);
  }
  // инфра-мутации закрыты флагом:
  for (const n of ['orchestrator_create_infra_task', 'orchestrator_complete_reasoning_task', 'orchestrator_release_reasoning_task']) {
    assert.ok(!names.includes(n), `нет ${n}`);
  }
});

test('orchestrator_list_infra_roles фильтрует /api/mcp-roles до инфра-кодов', async () => {
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => [
        { code: 'PROGRAMMER' },
        { code: 'INFRA_ARCHITECT' },
        { code: 'security_engineer' }, // нижний регистр — тоже инфра
        { code: 'ARCHITECT' },
        { code: 'K8S_ENGINEER' },
      ],
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_list_infra_roles')({});
  const parsed = JSON.parse(out.content[0].text);
  const codes = parsed.roles.map((r) => r.code);
  assert.deepEqual(codes, ['INFRA_ARCHITECT', 'security_engineer', 'K8S_ENGINEER']);
  assert.ok(!out.isError);
});

test('orchestrator_list_infra_roles принимает форму { roles: [...] }', async () => {
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ roles: [{ roleCode: 'DEVOPS_ENGINEER' }, { roleCode: 'PROGRAMMER' }] }),
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_list_infra_roles')({});
  const parsed = JSON.parse(out.content[0].text);
  assert.deepEqual(parsed.roles.map((r) => r.roleCode), ['DEVOPS_ENGINEER']);
});

test('orchestrator_get_infra_role отклоняет не-инфра роль без вызова backend', async () => {
  let called = false;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => { called = true; return { ok: true, status: 200, data: {} }; },
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_get_infra_role')({ roleCode: 'PROGRAMMER' });
  assert.equal(called, false);
  assert.equal(out.isError, true);
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.code, 'not_infra_role');
});

test('orchestrator_get_infra_role принимает INFRA_ARCHITECT и шлёт GET /api/mcp-roles/:code', async () => {
  let seenPath;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path) => { seenPath = path; return { ok: true, status: 200, data: { code: 'INFRA_ARCHITECT', prompt: 'p' } }; },
      post: async () => ({}),
    },
  });
  const out = await server.handlers.get('orchestrator_get_infra_role')({ roleCode: 'INFRA_ARCHITECT' });
  assert.equal(seenPath, '/api/mcp-roles/INFRA_ARCHITECT');
  assert.ok(!out.isError);
});

test('orchestrator_list_infra_tasks шлёт GET /api/infra/tasks (с project и без)', async () => {
  const seen = [];
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path, options) => { seen.push({ path, options }); return { ok: true, status: 200, data: { tasks: [] } }; },
      post: async () => ({}),
    },
  });
  await server.handlers.get('orchestrator_list_infra_tasks')({});
  await server.handlers.get('orchestrator_list_infra_tasks')({ project: 'INFRA' });
  assert.equal(seen[0].path, '/api/infra/tasks');
  assert.deepEqual(seen[0].options, { query: {} });
  assert.deepEqual(seen[1].options, { query: { project: 'INFRA' } });
});

test('orchestrator_claim_next_reasoning_task шлёт engine (и role при наличии)', async () => {
  const seen = [];
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig(),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async (path, options) => { seen.push({ path, options }); return { ok: true, status: 200, data: {} }; },
      post: async () => ({}),
    },
  });
  await server.handlers.get('orchestrator_claim_next_reasoning_task')({ engine: 'codex' });
  await server.handlers.get('orchestrator_claim_next_reasoning_task')({ engine: 'claude_code', role: 'SECURITY_ENGINEER' });
  assert.equal(seen[0].path, '/api/runner/next-reasoning-task');
  assert.deepEqual(seen[0].options, { query: { engine: 'codex' } });
  assert.deepEqual(seen[1].options, { query: { engine: 'claude_code', role: 'SECURITY_ENGINEER' } });
});

test('MCP_ENABLE_ORCHESTRATOR_MUTATIONS добавляет инфра/reasoning мутации', () => {
  const names = registerTools(fakeServer(), { config: baseConfig({ enableOrchestratorMutations: true }), ...stubClients });
  for (const n of ['orchestrator_create_infra_task', 'orchestrator_complete_reasoning_task', 'orchestrator_release_reasoning_task']) {
    assert.ok(names.includes(n), `есть ${n}`);
  }
});

test('orchestrator_create_infra_task постит task-intake с entryRole=INFRA_ARCHITECT и project=INFRA по умолчанию', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: { accepted: true, taskId: 'i1' } }; },
    },
  });
  const out = await server.handlers.get('orchestrator_create_infra_task')({ externalId: 'infra-1', title: 'Поднять мониторинг' });
  assert.equal(seen.path, '/api/scanner/task-intake');
  assert.equal(seen.body.entryRole, 'INFRA_ARCHITECT');
  assert.equal(seen.body.project, 'INFRA');
  assert.equal(seen.body.externalId, 'infra-1');
  const parsed = JSON.parse(out.content[0].text);
  assert.equal(parsed.data.taskId, 'i1');
  assert.ok(!out.isError);
});

test('orchestrator_create_infra_task уважает переданный project', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: {} }; },
    },
  });
  await server.handlers.get('orchestrator_create_infra_task')({ externalId: 'infra-2', title: 'T', project: 'INFRA_STAGING' });
  assert.equal(seen.body.project, 'INFRA_STAGING');
  assert.equal(seen.body.entryRole, 'INFRA_ARCHITECT');
});

test('orchestrator_create_infra_task без mutation-флага НЕ регистрируется', () => {
  const names = registerTools(fakeServer(), { config: baseConfig(), ...stubClients });
  assert.ok(!names.includes('orchestrator_create_infra_task'));
});

test('orchestrator_complete_reasoning_task постит /api/runner/reasoning-completed', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: {} }; },
    },
  });
  await server.handlers.get('orchestrator_complete_reasoning_task')({
    taskId: 't9', status: 'ok', summary: 's', findings: ['f1'], fields: { a: 1 },
  });
  assert.equal(seen.path, '/api/runner/reasoning-completed');
  assert.equal(seen.body.taskId, 't9');
  assert.equal(seen.body.status, 'ok');
  assert.deepEqual(seen.body.findings, ['f1']);
  assert.deepEqual(seen.body.fields, { a: 1 });
});

test('orchestrator_release_reasoning_task постит /api/runner/release-reasoning-task', async () => {
  let seen;
  const server = fakeServer();
  registerTools(server, {
    config: baseConfig({ enableOrchestratorMutations: true }),
    toolsClient: stubClients.toolsClient,
    orchestratorClient: {
      get: async () => ({ ok: true, status: 200, data: {} }),
      post: async (path, body) => { seen = { path, body }; return { ok: true, status: 200, data: {} }; },
    },
  });
  await server.handlers.get('orchestrator_release_reasoning_task')({ taskId: 't10' });
  assert.equal(seen.path, '/api/runner/release-reasoning-task');
  assert.deepEqual(seen.body, { taskId: 't10' });
});
