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

test('GET /api/settings без токена → 401', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`);
  assert.equal(res.status, 401);
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
