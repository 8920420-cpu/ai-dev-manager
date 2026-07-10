import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner } from '../src/taskRunner.js';

const silent = { info() {}, error() {}, warn() {} };
const noHeartbeat = async () => {};

test('tick прокидывает применённые переходы из advance', async () => {
  const applied = [{ taskId: 't1', toStatus: 'TESTING' }];
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({ host: 'x' }),
    advance: async () => applied,
    heartbeat: noHeartbeat,
  });
  assert.deepEqual(await runner.tick(), applied);
});

test('tick не падает, если advance бросает', async () => {
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({}),
    advance: async () => { throw new Error('db down'); },
    heartbeat: noHeartbeat,
  });
  assert.deepEqual(await runner.tick(), []);
});

test('параллельные tick не реэнтерабельны', async () => {
  let active = 0;
  let maxActive = 0;
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({}),
    advance: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 20));
      active -= 1;
      return [];
    },
    heartbeat: noHeartbeat,
  });
  await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
  assert.equal(maxActive, 1);
});

// ORCH-DOWNTIME-MARKER-001: heartbeat бьётся каждый тик и не рушит тик при ошибке.
test('tick бьёт heartbeat', async () => {
  let beats = 0;
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({}),
    advance: async () => [],
    heartbeat: async () => { beats += 1; },
  });
  await runner.tick();
  assert.equal(beats, 1);
});

test('tick продолжает работу, если heartbeat падает', async () => {
  const applied = [{ taskId: 't9' }];
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({}),
    advance: async () => applied,
    heartbeat: async () => { throw new Error('hb down'); },
  });
  assert.deepEqual(await runner.tick(), applied);
});
