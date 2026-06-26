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
