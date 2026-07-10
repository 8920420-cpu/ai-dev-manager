import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { TesterService, TesterInputError } from '../src/TesterService.js';

function tmpProject(t, { withConfig = true } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tester-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (withConfig) {
    writeFileSync(path.join(dir, '.pipeline.json'), JSON.stringify({ stages: { build: ['true'] } }));
  }
  return dir;
}

/** Записать поддельный summary.json в каталог запуска, как это делает Pipeline Runner. */
function fakeReport(dir, runId, summary) {
  const reportDir = path.join(dir, '.tmp', 'pipeline-results', runId);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, 'summary.json'), JSON.stringify(summary));
  writeFileSync(path.join(reportDir, 'pipeline.log'), 'log');
  return reportDir;
}

const baseInput = (dir) => ({
  taskId: 'TASK-1',
  projectPath: dir,
  changedFiles: ['a.js'],
  programmerComment: 'готово',
});

test('success → nextRole=Documentation Auditor, результат сохранён', async (t) => {
  const dir = tmpProject(t);
  const reportDir = fakeReport(dir, 'run-ok', { status: 'success', name: 'Demo', stages: [] });
  const service = new TesterService({
    cwd: dir,
    runPipeline: async () => ({ success: true, runId: 'run-ok', reportPath: path.relative(dir, reportDir) }),
  });

  const res = await service.runCheck(baseInput(dir));

  assert.equal(res.status, 'success');
  assert.equal(res.nextRole, 'Documentation Auditor');
  assert.equal(res.runId, 'run-ok');
  assert.ok(res.summaryPath.endsWith('summary.json'));
  assert.ok(res.logPath.endsWith('pipeline.log'));
  assert.ok(existsSync(res.resultPath), 'результат должен быть сохранён на диск');

  const saved = JSON.parse(readFileSync(res.resultPath, 'utf8'));
  assert.equal(saved.input.changedFiles[0], 'a.js');
  assert.equal(saved.input.programmerComment, 'готово');
});

test('failed → nextRole=Failure Analyst, summary/logPath/failedStage заданы', async (t) => {
  const dir = tmpProject(t);
  const reportDir = fakeReport(dir, 'run-bad', {
    status: 'failed', name: 'Demo', failedStage: 'build', durationSeconds: 1.2,
    stages: [{ name: 'build' }],
  });
  const service = new TesterService({
    cwd: dir,
    runPipeline: async () => ({ success: false, runId: 'run-bad', failedStage: 'build', reportPath: path.relative(dir, reportDir) }),
  });

  const res = await service.runCheck(baseInput(dir));

  assert.equal(res.status, 'failed');
  assert.equal(res.nextRole, 'Failure Analyst');
  assert.equal(res.failedStage, 'build');
  assert.ok(res.summary.includes('build'));
  assert.ok(res.logPath.endsWith('pipeline.log'));
});

test('нет .pipeline.json → status=error, Pipeline Runner не вызывается', async (t) => {
  const dir = tmpProject(t, { withConfig: false });
  let called = false;
  const service = new TesterService({
    cwd: dir,
    runPipeline: async () => { called = true; return {}; },
  });

  const res = await service.runCheck({ taskId: 'T', projectPath: dir });

  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'pipeline_config_not_found');
  assert.equal(called, false, 'Runner не должен запускаться без конфига');
});

test('сбой Pipeline Runner до этапов → status=error, reason=pipeline_runner_error', async (t) => {
  const dir = tmpProject(t);
  const service = new TesterService({
    cwd: dir,
    runPipeline: async () => { throw new Error('bad config'); },
  });

  const res = await service.runCheck(baseInput(dir));

  assert.equal(res.status, 'error');
  assert.equal(res.reason, 'pipeline_runner_error');
  assert.ok(res.message.includes('bad config'));
});

test('пустой taskId/projectPath → TesterInputError', async (t) => {
  const dir = tmpProject(t);
  const service = new TesterService({ cwd: dir, runPipeline: async () => ({}) });
  await assert.rejects(() => service.runCheck({ projectPath: dir }), TesterInputError);
  await assert.rejects(() => service.runCheck({ taskId: 'T' }), TesterInputError);
});

test('workspaceRoot: projectPath вне корня отклоняется', async (t) => {
  const root = tmpProject(t, { withConfig: false });
  const outside = tmpProject(t); // отдельный временный каталог вне root
  const service = new TesterService({ cwd: root, workspaceRoot: root, runPipeline: async () => ({}) });
  await assert.rejects(
    () => service.runCheck({ taskId: 'T', projectPath: outside }),
    TesterInputError
  );
});

test('workspaceRoot: pipelineConfigPath вне корня отклоняется', async (t) => {
  const root = tmpProject(t);
  const outside = tmpProject(t);
  const service = new TesterService({ cwd: root, workspaceRoot: root, runPipeline: async () => ({}) });
  await assert.rejects(
    () =>
      service.runCheck({
        taskId: 'T',
        projectPath: root,
        pipelineConfigPath: path.join(outside, '.pipeline.json'),
      }),
    TesterInputError
  );
});

test('workspaceRoot: путь внутри корня разрешён', async (t) => {
  const root = tmpProject(t);
  const reportDir = fakeReport(root, 'run-ok', { status: 'success', name: 'Demo', stages: [] });
  const service = new TesterService({
    cwd: root,
    workspaceRoot: root,
    runPipeline: async () => ({ success: true, runId: 'run-ok', reportPath: path.relative(root, reportDir) }),
  });
  const res = await service.runCheck({ taskId: 'T', projectPath: root });
  assert.equal(res.status, 'success');
});
