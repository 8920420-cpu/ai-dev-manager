import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// RUNNER-HEARTBEAT-001. shared/heartbeat.js читает RUNNER_HEARTBEAT_FILE ОДИН РАЗ при
// загрузке модуля, поэтому два состояния env проверяем через cache-busting query
// (?case=…) — каждый импорт даёт отдельный инстанс модуля со своим снимком окружения.
const hbPath = path.join(tmpdir(), `hb-test-${process.pid}.heartbeat`);

test('beat() пишет числовую метку живости, когда задан RUNNER_HEARTBEAT_FILE', async () => {
  if (existsSync(hbPath)) rmSync(hbPath, { force: true });
  process.env.RUNNER_HEARTBEAT_FILE = hbPath;
  const { beat, heartbeatEnabled } = await import('../../shared/heartbeat.js?case=set');
  assert.equal(heartbeatEnabled(), true);
  beat();
  assert.equal(existsSync(hbPath), true, 'файл heartbeat создан');
  const v = Number(readFileSync(hbPath, 'utf8'));
  assert.ok(Number.isFinite(v) && v > 0, 'в файле — числовая метка времени (мс)');
  rmSync(hbPath, { force: true });
});

test('beat() — безопасный no-op, когда RUNNER_HEARTBEAT_FILE не задан', async () => {
  delete process.env.RUNNER_HEARTBEAT_FILE;
  const { beat, heartbeatEnabled } = await import('../../shared/heartbeat.js?case=unset');
  assert.equal(heartbeatEnabled(), false);
  assert.doesNotThrow(() => beat(), 'без переменной beat() не бросает и ничего не пишет');
});
