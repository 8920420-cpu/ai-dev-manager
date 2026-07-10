// MCP-SERVICE-001 — smoke: реальная сборка сервера и HTTP health.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer, startHttp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

test('buildServer регистрирует read-инструменты на реальном McpServer', () => {
  const { tools } = buildServer(loadConfig({ PROJECT_ROOT: '/x' }));
  assert.ok(tools.length >= 11, `инструментов >= 11 (получено ${tools.length})`);
  assert.ok(tools.includes('project_read_file'));
  assert.ok(tools.includes('project_search_text'));
  assert.ok(tools.includes('orchestrator_health'));
  assert.ok(tools.includes('orchestrator_list_projects'));
  // INFRA-DEPARTMENT-001 — инфра read-only и reasoning-claim регистрируются всегда:
  assert.ok(tools.includes('orchestrator_list_infra_roles'));
  assert.ok(tools.includes('orchestrator_get_infra_role'));
  assert.ok(tools.includes('orchestrator_list_infra_tasks'));
  assert.ok(tools.includes('orchestrator_claim_next_reasoning_task'));
});

test('HTTP-режим отдаёт health 200 на эфемерном порту', async () => {
  const config = loadConfig({ MCP_SERVICE_PORT: '0' });
  const server = startHttp(config, { logger: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'mcp-service');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/mcp без токена при заданном ORCHESTRATOR_API_TOKEN → 401, /health открыт', async () => {
  const config = loadConfig({ MCP_SERVICE_PORT: '0', ORCHESTRATOR_API_TOKEN: 'secret' });
  const server = startHttp(config, { logger: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(health.status, 200);

    const noAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noAuth.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/mcp with empty ORCHESTRATOR_API_TOKEN is 401 by default', async () => {
  const config = loadConfig({ MCP_SERVICE_PORT: '0' });
  const server = startHttp(config, { logger: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 401);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/mcp с превышением лимита тела → 413', async () => {
  // Лимит floor'ится до минимума 1024 байт; шлём заведомо больше, чтобы сработал 413.
  const config = loadConfig({ MCP_SERVICE_PORT: '0', MCP_BODY_LIMIT_BYTES: '1024', ALLOW_INSECURE_LOCAL: '1' });
  const server = startHttp(config, { logger: () => {} });
  await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(4000) }),
    });
    assert.equal(res.status, 413);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
