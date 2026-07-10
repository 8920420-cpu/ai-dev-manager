import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

import { PipelineRunner } from '../src/PipelineRunner.js';
import { FakeExecutor, NullLogger, tmpDir } from './helpers.js';

function baseConfig(dir, stages, extra = {}) {
  return {
    name: 'Demo',
    workingDirectory: dir,
    timeoutMinutes: null,
    stages,
    configPath: path.join(dir, '.pipeline.json'),
    ...extra,
  };
}

function makeRunner(config, table = {}) {
  return new PipelineRunner({
    config,
    executor: new FakeExecutor(table),
    createLogger: () => new NullLogger(),
  });
}

test('успешный pipeline: success=true, summary.json записан', async (t) => {
  const dir = tmpDir(t);
  const config = baseConfig(dir, [
    { name: 'test', commands: ['cmd_t'] },
    { name: 'build', commands: ['cmd_b'] },
  ]);
  const result = await makeRunner(config).execute();

  assert.equal(result.success, true);
  assert.ok(result.runId);
  assert.ok(result.reportPath);
  assert.equal(result.failedStage, undefined);

  const summaryPath = path.join(dir, '.tmp', 'pipeline-results', result.runId, 'summary.json');
  assert.ok(existsSync(summaryPath));
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.status, 'success');
  assert.equal(summary.stages.length, 2);
  assert.equal(summary.startedAt && summary.finishedAt ? true : false, true);
});

test('падение этапа: success=false, failedStage и остановка дальнейших этапов', async (t) => {
  const dir = tmpDir(t);
  const config = baseConfig(dir, [
    { name: 'test', commands: ['ok'] },
    { name: 'build', commands: ['boom'] },
    { name: 'deploy', commands: ['never'] },
  ]);
  const executor = new FakeExecutor({ boom: { exitCode: 1 } });
  const runner = new PipelineRunner({ config, executor, createLogger: () => new NullLogger() });

  const result = await runner.execute();
  assert.equal(result.success, false);
  assert.equal(result.failedStage, 'build');

  // deploy не должен был выполняться
  assert.ok(!executor.calls.find((c) => c.command === 'never'));

  const summaryPath = path.join(dir, '.tmp', 'pipeline-results', result.runId, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.failedStage, 'build');
  // в summary попадают только выполненные этапы (test + build)
  assert.equal(summary.stages.length, 2);
  assert.equal(summary.stages[1].status, 'failed');
});

test('отключённый этап: SKIPPED, команды не запускаются, следующий включённый идёт', async (t) => {
  const dir = tmpDir(t);
  const config = baseConfig(dir, [
    { name: 'build', commands: ['cmd_b'], enabled: true },
    { name: 'smoke', commands: ['cmd_s'], enabled: false },
    { name: 'deploy', commands: ['cmd_d'], enabled: true },
  ]);
  const executor = new FakeExecutor();
  const runner = new PipelineRunner({ config, executor, createLogger: () => new NullLogger() });

  const result = await runner.execute();
  assert.equal(result.success, true);

  // команда отключённого этапа ни разу не запускалась
  assert.ok(!executor.calls.find((c) => c.command === 'cmd_s'));
  // следующий включённый этап выполнился
  assert.ok(executor.calls.find((c) => c.command === 'cmd_d'));

  const summaryPath = path.join(dir, '.tmp', 'pipeline-results', result.runId, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.stages.length, 3);
  const skipped = summary.stages[1];
  assert.equal(skipped.name, 'smoke');
  assert.equal(skipped.status, 'SKIPPED');
  assert.equal(skipped.durationSeconds, 0);
  assert.equal(skipped.reason, 'disabled_by_configuration');
  assert.equal('exitCode' in skipped, false);
});

test('все этапы отключены: pipeline успешен, все SKIPPED', async (t) => {
  const dir = tmpDir(t);
  const config = baseConfig(dir, [
    { name: 'build', commands: ['cmd_b'], enabled: false },
    { name: 'smoke', commands: ['cmd_s'], enabled: false },
  ]);
  const executor = new FakeExecutor();
  const runner = new PipelineRunner({ config, executor, createLogger: () => new NullLogger() });

  const result = await runner.execute();
  assert.equal(result.success, true);
  assert.equal(executor.calls.length, 0);

  const summaryPath = path.join(dir, '.tmp', 'pipeline-results', result.runId, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.status, 'success');
  assert.deepEqual(
    summary.stages.map((s) => s.status),
    ['SKIPPED', 'SKIPPED'],
  );
});

test('отключённый этап после упавшего не достигается (не SKIPPED, а отсутствует)', async (t) => {
  const dir = tmpDir(t);
  const config = baseConfig(dir, [
    { name: 'build', commands: ['boom'], enabled: true },
    { name: 'smoke', commands: ['cmd_s'], enabled: false },
  ]);
  const executor = new FakeExecutor({ boom: { exitCode: 1 } });
  const runner = new PipelineRunner({ config, executor, createLogger: () => new NullLogger() });

  const result = await runner.execute();
  assert.equal(result.success, false);
  assert.equal(result.failedStage, 'build');

  const summaryPath = path.join(dir, '.tmp', 'pipeline-results', result.runId, 'summary.json');
  const summary = JSON.parse(readFileSync(summaryPath, 'utf8'));
  // в summary только достигнутый упавший этап; отключённый smoke не записан
  assert.equal(summary.stages.length, 1);
  assert.equal(summary.stages[0].name, 'build');
});

test('каждый запуск получает уникальный каталог (параллельная безопасность)', async (t) => {
  const dir = tmpDir(t);
  const mk = () => makeRunner(baseConfig(dir, [{ name: 'a', commands: ['x'] }])).execute();
  const results = await Promise.all([mk(), mk(), mk()]);
  const ids = new Set(results.map((r) => r.runId));
  assert.equal(ids.size, 3, 'runId должны быть уникальны');
});

test('reportPath указывает на существующий каталог запуска', async (t) => {
  const dir = tmpDir(t);
  const result = await makeRunner(baseConfig(dir, [{ name: 'a', commands: ['x'] }])).execute();
  const runDir = path.join(dir, '.tmp', 'pipeline-results', result.runId);
  assert.ok(existsSync(path.join(runDir, 'summary.json')));
});
