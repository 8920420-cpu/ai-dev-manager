import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Изолированный файл настроек + токен — задаём ДО импорта server.js,
// т.к. API_TOKEN считывается на этапе загрузки модуля.
const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-server-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
process.env.ORCHESTRATOR_API_TOKEN = 'test-token';

const { createApp } = await import('../src/server.js');
const { saveSettings } = await import('../src/config.js');

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

function startServer(t) {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      t.after(() => new Promise((r) => server.close(r)));
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

test('GET /health открыт без токена', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
});

test('GET /api/version открыт без токена и всегда отдаёт версию', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/version`);
  assert.equal(res.status, 200, 'healthcheck доступен без токена');
  const body = await res.json();
  assert.equal(body.service, 'orchestrator-service');
  assert.equal(typeof body.version, 'string');
  assert.ok(body.version.length > 0, 'версия сервиса не пустая');
  // Контракт устойчивости: даже когда БД недоступна (в тесте подключения нет),
  // эндпоинт возвращает 200 с версией, а блок migrations присутствует и валиден.
  assert.ok(body.migrations && typeof body.migrations === 'object');
  assert.equal(typeof body.migrations.count, 'number');
  assert.ok(Array.isArray(body.migrations.applied));
  assert.ok('latest' in body.migrations);
});

test('GET /api/settings без токена → 401', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`);
  assert.equal(res.status, 401);
});

test('GET /api/tasks/events без токена → 401', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/tasks/events`);
  assert.equal(res.status, 401);
});

test('GET /api/tasks/events с query-токеном открывает event-stream', async (t) => {
  const base = await startServer(t);
  const ctrl = new AbortController();
  t.after(() => ctrl.abort());
  const res = await fetch(`${base}/api/tasks/events?token=test-token`, { signal: ctrl.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /^text\/event-stream/);
  const reader = res.body.getReader();
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  assert.match(text, /event: ready/);
  await reader.cancel();
});

test('GET /api/settings с токеном → 200 и без пароля', async (t) => {
  await saveSettings({ password: 'super-secret' });
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal('password' in body, false, 'пароль не должен уходить клиенту');
  assert.equal(body.hasPassword, true);
});

test('X-Api-Token также принимается', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`, { headers: { 'X-Api-Token': 'test-token' } });
  assert.equal(res.status, 200);
});

test('неверный токен → 401', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`, {
    headers: { Authorization: 'Bearer wrong' },
  });
  assert.equal(res.status, 401);
});
