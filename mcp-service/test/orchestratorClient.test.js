// MCP-SERVICE-001 — тесты HTTP-клиента orchestrator-service (с мок-fetch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestratorClient } from '../src/orchestratorClient.js';

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

test('get: успешный ответ возвращает { ok, status, data }', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(url, 'http://o/api/projects');
    assert.equal(init.method, 'GET');
    return jsonResponse(200, [{ id: 1 }]);
  };
  const client = createOrchestratorClient({ baseUrl: 'http://o', fetchImpl });
  const r = await client.get('/api/projects');
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [{ id: 1 }]);
});

test('get: query-параметры собираются, пустые пропускаются', async () => {
  let seen;
  const fetchImpl = async (url) => {
    seen = url;
    return jsonResponse(200, {});
  };
  const client = createOrchestratorClient({ baseUrl: 'http://o', fetchImpl });
  await client.get('/api/runner/next-host-task', { query: { role: 'PIPELINE_SERVICE', empty: '', skip: null } });
  assert.equal(seen, 'http://o/api/runner/next-host-task?role=PIPELINE_SERVICE');
});

test('post: тело сериализуется, Bearer проставляется', async () => {
  const fetchImpl = async (url, init) => {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer T');
    assert.equal(init.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { taskId: 'abc' });
    return jsonResponse(200, { released: true });
  };
  const client = createOrchestratorClient({ baseUrl: 'http://o', token: 'T', fetchImpl });
  const r = await client.post('/api/runner/release-claude-task', { taskId: 'abc' });
  assert.equal(r.ok, true);
});

test('HTTP-ошибка нормализуется в { ok:false, error, code, status }', async () => {
  const fetchImpl = async () => jsonResponse(401, { error: 'unauthorized' });
  const client = createOrchestratorClient({ baseUrl: 'http://o', fetchImpl });
  const r = await client.get('/api/projects');
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.equal(r.error, 'unauthorized');
});

test('таймаут (AbortError) → код timeout, без падения', async () => {
  const fetchImpl = async () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    throw e;
  };
  const client = createOrchestratorClient({ baseUrl: 'http://o', timeoutMs: 5, fetchImpl });
  const r = await client.get('/health');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'timeout');
});
