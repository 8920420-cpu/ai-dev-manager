import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'orch-client-auth-'));
process.env.ORCHESTRATOR_SETTINGS_PATH = path.join(tmpDir, 'db.settings.json');
process.env.ORCHESTRATOR_API_TOKEN = 'server-secret-token';
process.env.UI_BOOTSTRAP_API_TOKEN = '1';
delete process.env.ALLOW_INSECURE_LOCAL;

const { createApp } = await import(`../src/server.js?client-auth=${Date.now()}`);

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

test('/api/client-auth never exposes ORCHESTRATOR_API_TOKEN', async (t) => {
  const base = await startServer(t);
  const res = await fetch(`${base}/api/client-auth`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { token: null });
});
