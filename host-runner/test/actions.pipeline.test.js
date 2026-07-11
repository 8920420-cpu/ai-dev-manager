import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

// ── Изоляция TESTING на ветке сдачи (WORKTREE-ISOLATE-DELIVERY-001) ────────────

function gitIn(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

test('worktree-сдача → TESTING в ИЗОЛИРОВАННОМ checkout доставленного коммита, общее дерево чистое', async (t) => {
  const root = tmpDir(t);
  // Реальный git-репо: base commit с .pipeline.json сервиса (стадия build).
  gitIn(root, ['init', '--quiet']);
  gitIn(root, ['config', 'user.email', 'test@local']);
  gitIn(root, ['config', 'user.name', 'test']);
  gitIn(root, ['config', 'commit.gpgsign', 'false']);
  gitIn(root, ['config', 'core.autocrlf', 'false']);
  // Верификационная стадия (test) — она выполняется и в изоляции (в отличие от
  // build/deploy/smoke, которые в изолированном worktree пропускаются).
  writeServiceConfig(root, 'svc', { test: { commands: ['npm test'], enabled: true } });
  gitIn(root, ['add', '-A']);
  gitIn(root, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'init']);

  // Ветка сервиса с дельтой (маркер DELTA.txt, которого НЕТ в main) — коммитим её
  // через отдельный worktree, не переключая основную ветку общего дерева.
  const branch = 'programmer/PROJECT/svc';
  const bwt = path.join(os.tmpdir(), `bwt-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(bwt, { recursive: true, force: true }));
  gitIn(root, ['worktree', 'add', '--quiet', '-b', branch, bwt, 'HEAD']);
  writeFileSync(path.join(bwt, 'svc', 'DELTA.txt'), 'delta-only\n');
  gitIn(bwt, ['add', '-A']);
  gitIn(bwt, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'programmer: task delta']);
  const deliveredCommit = gitIn(bwt, ['rev-parse', 'HEAD']).trim();
  gitIn(root, ['worktree', 'remove', '--force', bwt]);

  // Исполнитель фиксирует cwd и наличие дельты в МОМЕНТ запуска (worktree ещё жив).
  let seen = null;
  const executor = {
    calls: [],
    async run(command, opts = {}) {
      seen = { cwd: opts.cwd, deltaPresent: existsSync(path.join(opts.cwd, 'DELTA.txt')) };
      this.calls.push({ command, opts });
      return { command, exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, error: null, durationSeconds: 0.01 };
    },
  };

  const task = claimTask({ root, serviceRel: 'svc', serviceCode: 'svc' });
  task.worktreeBranch = branch;
  task.deliveredCommit = deliveredCommit;

  const result = await runPipelineAction(task, { runnerDeps: runnerDeps(executor) });
  assert.equal(result.success, true);
  assert.ok(seen, 'команда сервиса выполнялась');
  // cwd НЕ в общем дереве root/svc, а во временном изолированном worktree.
  assert.notEqual(path.resolve(seen.cwd), path.resolve(root, 'svc'), 'TESTING не в общем дереве');
  // PIPELINE-WORKTREE-LONGPATH-001: путь worktree в каноничном ДЛИННОМ виде, без
  // 8.3-короткого имени (напр. 7272~1) — иначе vite не грузит setupFiles.
  assert.ok(!/~\d/.test(seen.cwd), `worktree путь не должен содержать 8.3-короткое имя: ${seen.cwd}`);
  assert.equal(seen.deltaPresent, true, 'изолированный checkout несёт доставленную дельту');
  // Общее дерево репозитория осталось чистым (его Программист/Pipeline не трогали).
  assert.equal(gitIn(root, ['status', '--porcelain']).trim(), '', 'общее дерево чистое');
  // Эфемерный worktree снесён после прогона.
  assert.equal(existsSync(seen.cwd), false, 'эфемерный worktree убран');
});

test('worktree-сдача → build/deploy/smoke ПРОПУЩЕНЫ в изоляции, тесты выполняются', async (t) => {
  const root = tmpDir(t);
  gitIn(root, ['init', '--quiet']);
  gitIn(root, ['config', 'user.email', 'test@local']);
  gitIn(root, ['config', 'user.name', 'test']);
  gitIn(root, ['config', 'commit.gpgsign', 'false']);
  gitIn(root, ['config', 'core.autocrlf', 'false']);
  writeServiceConfig(root, 'svc', {
    test: { commands: ['npm test'], enabled: true },
    build: { commands: ['docker compose build'], enabled: true },
    deploy: { commands: ['docker compose up -d'], enabled: true },
    smoke: { commands: ['curl -f http://localhost:4186/health'], enabled: true },
  });
  gitIn(root, ['add', '-A']);
  gitIn(root, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'init']);

  const branch = 'programmer/PROJECT/svc';
  const bwt = path.join(os.tmpdir(), `bwt2-${process.pid}-${Date.now()}`);
  t.after(() => rmSync(bwt, { recursive: true, force: true }));
  gitIn(root, ['worktree', 'add', '--quiet', '-b', branch, bwt, 'HEAD']);
  writeFileSync(path.join(bwt, 'svc', 'DELTA.txt'), 'delta\n');
  gitIn(bwt, ['add', '-A']);
  gitIn(bwt, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'programmer: task delta']);
  const deliveredCommit = gitIn(bwt, ['rev-parse', 'HEAD']).trim();
  gitIn(root, ['worktree', 'remove', '--force', bwt]);

  const executor = new FakeExecutor();
  const task = claimTask({ root, serviceRel: 'svc', serviceCode: 'svc' });
  task.worktreeBranch = branch;
  task.deliveredCommit = deliveredCommit;

  const result = await runPipelineAction(task, { runnerDeps: runnerDeps(executor) });

  assert.equal(result.success, true);
  const ran = executor.calls.map((c) => c.command);
  // Только верификация; деплой-стадии не выполнялись (общий стек не тронут).
  assert.deepEqual(ran, ['npm test']);
  assert.ok(!ran.includes('docker compose build'));
  assert.ok(!ran.includes('docker compose up -d'));
  // В summary build/deploy/smoke отражены как SKIPPED с причиной изоляции.
  const stages = Object.fromEntries(
    result.output.summary.actions.map((a) => [a.stage, a]),
  );
  assert.equal(stages.build.status, 'SKIPPED');
  assert.equal(stages.build.reason, 'skipped_in_isolation');
  assert.equal(stages.deploy.status, 'SKIPPED');
  assert.equal(stages.smoke.status, 'SKIPPED');
});

test('worktree-сдача без deliveredCommit/ветки → фолбэк на общее дерево (совместимость)', async (t) => {
  const root = tmpDir(t);
  const svcDir = writeServiceConfig(root, 'svc', { build: { commands: ['docker compose build'], enabled: true } });
  const executor = new FakeExecutor();
  // Ни worktreeBranch, ни deliveredCommit — legacy-сдача: гоняем в общем дереве.
  const result = await runPipelineAction(claimTask({ root, serviceRel: 'svc', serviceCode: 'svc' }), {
    runnerDeps: runnerDeps(executor),
  });
  assert.equal(result.success, true);
  assert.equal(path.resolve(executor.calls[0].opts.cwd), path.resolve(svcDir), 'фолбэк — общее дерево сервиса');
});
