import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskRunner } from '../src/taskRunner.js';

const silent = { info() {}, error() {}, warn() {} };

test('tick прокидывает применённые переходы из advance', async () => {
  const applied = [{ taskId: 't1', toStatus: 'TESTING' }];
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({ host: 'x' }),
    advance: async () => applied,
  });
  assert.deepEqual(await runner.tick(), applied);
});

test('tick не падает, если advance бросает', async () => {
  const runner = createTaskRunner({
    log: silent,
    loadSettings: async () => ({}),
    advance: async () => { throw new Error('db down'); },
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
  });
  await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
  assert.equal(maxActive, 1);
});
