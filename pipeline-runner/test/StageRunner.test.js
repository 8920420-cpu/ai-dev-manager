import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StageRunner } from '../src/StageRunner.js';
import { FakeExecutor, NullLogger } from './helpers.js';

function makeRunner(table) {
  const executor = new FakeExecutor(table);
  const runner = new StageRunner({ executor, logger: new NullLogger() });
  return { runner, executor };
}

const ctx = { cwd: '.', env: {}, deadline: null };

test('успешный этап прогоняет все команды по порядку', async () => {
  const { runner, executor } = makeRunner({});
  const summary = await runner.run({ name: 'test', commands: ['a', 'b', 'c'] }, ctx);
  assert.equal(summary.status, 'success');
  assert.equal(summary.commands.length, 3);
  assert.deepEqual(
    executor.calls.map((c) => c.command),
    ['a', 'b', 'c'],
  );
});

test('этап останавливается на первой упавшей команде', async () => {
  const { runner, executor } = makeRunner({ b: { exitCode: 1 } });
  const summary = await runner.run({ name: 'build', commands: ['a', 'b', 'c'] }, ctx);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.exitCode, 1);
  assert.equal(summary.failedCommand, 'b');
  // команда c не должна выполняться
  assert.deepEqual(
    executor.calls.map((c) => c.command),
    ['a', 'b'],
  );
});

test('пустой этап успешен мгновенно', async () => {
  const { runner } = makeRunner({});
  const summary = await runner.run({ name: 'prepare', commands: [] }, ctx);
  assert.equal(summary.status, 'success');
  assert.equal(summary.commands.length, 0);
});

test('таймаут команды помечается reason=timeout', async () => {
  const { runner } = makeRunner({ slow: { timedOut: true, exitCode: null } });
  const summary = await runner.run({ name: 'deploy', commands: ['slow'] }, ctx);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.reason, 'timeout');
});

test('исчерпанный дедлайн pipeline прерывает этап до запуска команды', async () => {
  const { runner, executor } = makeRunner({});
  const summary = await runner.run(
    { name: 'x', commands: ['a'] },
    { cwd: '.', env: {}, deadline: Date.now() - 1000 },
  );
  assert.equal(summary.status, 'failed');
  assert.equal(summary.reason, 'timeout');
  assert.equal(executor.calls.length, 0); // команда даже не запускалась
});
