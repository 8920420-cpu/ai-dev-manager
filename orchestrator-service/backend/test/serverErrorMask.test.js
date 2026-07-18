import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-error-mask-'));
const settingsPath = path.join(tmpDir, 'db.settings.json');
writeFileSync(settingsPath, JSON.stringify({
  host: '127.0.0.1',
  port: 1,
  user: 'postgres',
  password: 'postgres',
  database: 'orchestrator_db',
  adminDatabase: 'postgres',
}));
process.env.ORCHESTRATOR_SETTINGS_PATH = settingsPath;
process.env.ORCHESTRATOR_API_TOKEN = 'test-token';
delete process.env.ALLOW_INSECURE_LOCAL;

const { createApp } = await import(`../src/server.js?error-mask=${Date.now()}`);

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

test('5xx API responses do not expose internal error messages', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/projects`, {
    headers: { Authorization: 'Bearer test-token' },
  });
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: 'internal_error' });
});
