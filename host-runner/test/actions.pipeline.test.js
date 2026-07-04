import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runPipelineAction } from '../src/actions.js';

/**
 * Тесты runPipelineAction (PIPELINE_SERVICE).
 *
 * Проверяют, что host-runner прогоняет pipeline ИМЕННО сервиса задачи по
 * контракту claim (`task.pipeline`) с реконсиляцией путей (абсолютный
 * projectRoot → projectsRoot, projectRoot→'.'); провал стадии даёт
 * success=false + failedStage (штатный маршрут в Failure Analyst); отсутствие
 * контракта — диагностируемый провал до запуска команд, а не ложный успех.
 *
 * Реальные процессы/docker не запускаются: в pipeline-runner инъектируется
 * поддельный исполнитель команд через opts.runnerDeps.
 */

// ── Поддельные зависимости pipeline-runner (без реальных процессов) ───────────

/** Логгер-заглушка: ничего не пишет на диск. */
class NullLogger {
  raw() {}
  info() {}
  warn() {}
  error() {}
  async close() {}
}

/** Поддельный CommandExecutor: результат по строке команды из таблицы. */
class FakeExecutor {
  constructor(table = {}) {
    this.table = table;
    this.calls = [];
  }
  async run(command, opts = {}) {
    this.calls.push({ command, opts });
    const preset = this.table[command] ?? {};
    return {
      command,
      exitCode: preset.exitCode ?? 0,
      signal: null,
      stdout: preset.stdout ?? '',
      stderr: preset.stderr ?? '',
      timedOut: preset.timedOut ?? false,
      error: preset.error ?? null,
      durationSeconds: 0.01,
    };
  }
}

function runnerDeps(executor) {
  return { executor, createLogger: () => new NullLogger() };
}

/** Временный каталог, удаляемый после теста. */
function tmpDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'host-runner-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Разложить .pipeline.json сервиса на диске: <root>/<serviceRel>/.pipeline.json. */
function writeServiceConfig(root, serviceRel, stages) {
  const dir = path.join(root, serviceRel);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, '.pipeline.json'),
    JSON.stringify({ name: serviceRel, workingDirectory: '.', timeoutMinutes: 15, stages }, null, 2),
  );
  return dir;
}

/**
 * Claim-задача как её отдаёт claimNextHostTask: projectRoot — АБСОЛЮТНЫЙ root_path.
 */
function claimTask({ root, serviceRel = 'orchestrator-service', serviceCode = 'orchestrator-service', id = 't-1' }) {
  return {
    id,
    role: 'PIPELINE_SERVICE',
    pipeline: {
      projectId: 'proj-uuid',
      projectCode: 'PROJECT',
      serviceId: 'svc-uuid',
      serviceCode,
      serviceName: serviceCode,
      projectRoot: root, // абсолютный (root_path) — реконсилируется в host-runner
      repositoryPath: serviceRel,
      workingDirectory: `${root}/${serviceRel}`,
      pipelineConfigRef: `${root}/${serviceRel}/.pipeline.json`,
    },
  };
}

// ── Сервисный режим: контракт есть ────────────────────────────────────────────

test('контракт есть → сервисный режим: прогон pipeline именно сервиса задачи', async (t) => {
  const root = tmpDir(t);
  writeServiceConfig(root, 'orchestrator-service', {
    'unit-tests': { commands: ['npm test'], enabled: true },
    build: { commands: ['docker compose build'], enabled: true },
    deploy: { commands: ['docker compose up -d'], enabled: true },
  });

  const executor = new FakeExecutor();
  const result = await runPipelineAction(claimTask({ root }), { runnerDeps: runnerDeps(executor) });

  assert.equal(result.success, true);
  // Выполнены команды ИМЕННО сервиса и в порядке стадий (тесты → build → deploy).
  assert.deepEqual(
    executor.calls.map((c) => c.command),
    ['npm test', 'docker compose build', 'docker compose up -d'],
  );
  // Идентичность сервиса и структура вывода для host-task-completed.
  assert.equal(result.output.summary.serviceCode, 'orchestrator-service');
  assert.equal(result.output.failedStage, null);
  assert.ok(result.output.startedAt);
  assert.ok('logPath' in result.output);
  assert.ok('runId' in result.output);
});

test('контракт есть → команды выполняются в рабочей директории сервиса', async (t) => {
  const root = tmpDir(t);
  const svcDir = writeServiceConfig(root, 'orchestrator-service', {
    build: { commands: ['docker compose build'], enabled: true },
  });

  const executor = new FakeExecutor();
  await runPipelineAction(claimTask({ root }), { runnerDeps: runnerDeps(executor) });

  // cwd команды = абсолютная рабочая директория сервиса (root/serviceRel).
  assert.equal(path.resolve(executor.calls[0].opts.cwd), path.resolve(svcDir));
});

test('провал стадии → success=false + failedStage (маршрут в Failure Analyst)', async (t) => {
  const root = tmpDir(t);
  writeServiceConfig(root, 'orchestrator-service', {
    'unit-tests': { commands: ['npm test'], enabled: true },
    build: { commands: ['docker compose build'], enabled: true },
    deploy: { commands: ['docker compose up -d'], enabled: true },
  });

  const executor = new FakeExecutor({ 'docker compose build': { exitCode: 1 } });
  const result = await runPipelineAction(claimTask({ root }), { runnerDeps: runnerDeps(executor) });

  assert.equal(result.success, false);
  assert.equal(result.output.failedStage, 'build');
  // fail-fast: стадия deploy после провала build не запускалась.
  assert.ok(!executor.calls.find((c) => c.command === 'docker compose up -d'));
});

test('контракт с невалидным путём сервиса → диагностируемый провал до команд', async (t) => {
  const root = tmpDir(t);
  const executor = new FakeExecutor();
  const task = claimTask({ root });
  task.pipeline.repositoryPath = '../../../etc'; // выход за корень проекта

  const result = await runPipelineAction(task, { runnerDeps: runnerDeps(executor) });

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_service_path_escape');
  assert.equal(executor.calls.length, 0);
});

// ── Контракта нет ─────────────────────────────────────────────────────────────

test('контракта нет → диагностируемый провал без запуска команд (не ложный успех)', async () => {
  const executor = new FakeExecutor();
  const result = await runPipelineAction(
    { id: 't-x', role: 'PIPELINE_SERVICE' },
    { runnerDeps: runnerDeps(executor) },
  );

  assert.equal(result.success, false);
  assert.equal(result.output.summary.error.code, 'pipeline_contract_missing');
  assert.equal(executor.calls.length, 0);
});
