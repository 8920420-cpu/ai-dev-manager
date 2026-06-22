import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

/** Поднять сервер на случайном порту и вернуть базовый URL + закрытие. */
function startServer(t, service) {
  const server = createServer({ service, log: () => {} });
  return new Promise((resolve) => {
    server.listen(0, () => {
      const { port } = server.address();
      t.after(() => new Promise((r) => server.close(r)));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('GET /health → 200 ok', async (t) => {
  const base = await startServer(t, { runCheck: async () => ({}) });
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('POST /test → проксирует результат ядра, 200 для success', async (t) => {
  const fakeService = {
    runCheck: async (input) => ({ status: 'success', nextRole: 'Documentation Auditor', echoed: input.taskId }),
  };
  const base = await startServer(t, fakeService);
  const res = await fetch(`${base}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ taskId: 'X', projectPath: '/tmp/p' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'success');
  assert.equal(body.echoed, 'X');
});

test('POST /test → 422 при status=error', async (t) => {
  const base = await startServer(t, { runCheck: async () => ({ status: 'error', reason: 'x' }) });
  const res = await fetch(`${base}/test`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(res.status, 422);
});

test('POST /test → 400 при некорректном JSON', async (t) => {
  const base = await startServer(t, { runCheck: async () => ({}) });
  const res = await fetch(`${base}/test`, { method: 'POST', body: '{не json' });
  assert.equal(res.status, 400);
});

test('неизвестный маршрут → 404', async (t) => {
  const base = await startServer(t, { runCheck: async () => ({}) });
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
