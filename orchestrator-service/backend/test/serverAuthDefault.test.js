import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-auth-default-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
delete process.env.ORCHESTRATOR_API_TOKEN;
delete process.env.ALLOW_INSECURE_LOCAL;

const { createApp } = await import(`../src/server.js?auth-default=${Date.now()}`);

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

test('empty ORCHESTRATOR_API_TOKEN is fail-closed for /api by default', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/settings`);
  assert.equal(res.status, 401);
});

test('health endpoints stay open without a token', async (t) => {
  const base = await startServer(t);
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/version`)).status, 200);
});
