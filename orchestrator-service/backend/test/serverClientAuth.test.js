import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { networkInterfaces } from 'node:os';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-client-auth-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
process.env.ORCHESTRATOR_API_TOKEN = 'server-secret-token';
process.env.UI_BOOTSTRAP_API_TOKEN = '1';
delete process.env.ALLOW_INSECURE_LOCAL;

const { createApp, isLoopbackAddress } = await import(`../src/server.js?client-auth=${Date.now()}`);

test.after(() => rmSync(tmpDir, { recursive: true, force: true }));

function startServer(t, host = '127.0.0.1') {
  const server = createApp();
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address();
      t.after(() => new Promise((r) => server.close(r)));
      resolve(port);
    });
  });
}

/** Первый внешний (не петлевой) IPv4 хоста — для проверки запроса «из сети». */
function externalIPv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

test('/api/client-auth: петлевой запрос с opt-in → токен выдан (bootstrap UI)', async (t) => {
  const port = await startServer(t);
  const res = await fetch(`http://127.0.0.1:${port}/api/client-auth`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: 'server-secret-token' });
});

test('/api/client-auth: без opt-in токен не выдаётся даже с петлевого адреса', async (t) => {
  const port = await startServer(t);
  const prev = process.env.UI_BOOTSTRAP_API_TOKEN;
  process.env.UI_BOOTSTRAP_API_TOKEN = '0';
  t.after(() => { process.env.UI_BOOTSTRAP_API_TOKEN = prev; });
  const res = await fetch(`http://127.0.0.1:${port}/api/client-auth`);
  assert.deepEqual(await res.json(), { token: null });
});

// CLIENT-AUTH-LOOPBACK-001: главная защита — запрос из сети токен НЕ получает,
// даже когда opt-in включён. Без внешнего интерфейса проверять нечего (skip).
test('/api/client-auth: запрос с внешнего адреса токен не получает при включённом opt-in', async (t) => {
  const ip = externalIPv4();
  if (!ip) return t.skip('нет внешнего IPv4-интерфейса');
  const port = await startServer(t, '0.0.0.0');
  const res = await fetch(`http://${ip}:${port}/api/client-auth`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: null }, 'из сети токен отдавать нельзя');
});

test('isLoopbackAddress: формы адреса Node и fail-closed на неизвестном', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('127.1.2.3'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  // Адрес docker-шлюза: именно его видит контейнер вместо отправителя.
  assert.equal(isLoopbackAddress('172.17.0.1'), false);
  assert.equal(isLoopbackAddress('192.168.1.211'), false);
  assert.equal(isLoopbackAddress('::ffff:192.168.1.211'), false);
  assert.equal(isLoopbackAddress(''), false);
  assert.equal(isLoopbackAddress(undefined), false);
  assert.equal(isLoopbackAddress(null), false);
});
