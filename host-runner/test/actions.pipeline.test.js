import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { runPipelineAction, runGitAction } from '../src/actions.js';

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

// ── Предохранитель GI: отказ доставке стухшей ветки, ревертящей main ───────────
// Регресс WORKTREE-SYNC-MAIN-001 (инцидент bbd7cc03): переиспользованная новой
// задачей БЕЗ ресинка на актуальный main программистская ветка отстаёт от main
// (древний merge-base). Её НЕТТО-дифф `git diff main <tip>` УДАЛЯЕТ файлы,
// которые main получил ПОСЛЕ расхождения (packages/app-switcher/* и т.п.) —
// доставка откатила бы влитую работу. GI обязан отклонить такую доставку с note
// 'stale_branch_reverts_main', не трогая main и не теряя autostash. Контрпример:
// удаление файла ВНУТРИ своего changed-set — легитимная дельта, проходит штатно.

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Временный git-репозиторий с одним коммитом на ветке main и детерминированной
// identity/окончаниями строк (иначе на Windows autocrlf портит сравнение blob).
function initRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gi-fuse-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@local']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']);
  return dir;
}

test('runGitAction: стухшая ветка, чей нетто-дифф удаляет файлы вне changed-set → отказ stale_branch_reverts_main, main не тронут, autostash сохранён', async (t) => {
  const dir = initRepo(t);

  // Ветка отходит от ДРЕВНЕГО main (только README) — эмуляция реюза без ресинка.
  git(dir, ['checkout', '--quiet', '-b', 'programmer/PROJECT_2/front_salesflow']);
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: task delta']);
  const deliveredCommit = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']);

  // main УШЁЛ ВПЕРЁД: получил файл, которого нет в стухшей ветке. Её нетто-дифф
  // относительно текущего main УДАЛИЛ БЫ этот файл (реверт влитой работы).
  mkdirSync(path.join(dir, 'packages', 'app-switcher'), { recursive: true });
  writeFileSync(path.join(dir, 'packages', 'app-switcher', 'index.js'), 'export const app = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'main: app-switcher влит другой задачей']);
  const mainHeadBefore = git(dir, ['rev-parse', 'HEAD']).trim();

  // Наследие Pipeline Service: дубль дельты ветки лежит незакоммиченным в дереве
  // → GI унесёт его в autostash. Проверяем, что при отказе autostash НЕ потерян.
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');

  const res = await runGitAction(
    {
      id: 't-stale',
      title: 'Sales flow',
      worktreeBranch: 'programmer/PROJECT_2/front_salesflow',
      deliveredCommit,
      changedFiles: ['feature.js'],
    },
    { repoRoot: dir },
  );

  // Доставка отклонена именно предохранителем нетто-удалений.
  assert.equal(res.success, false, 'стухшая ветка не должна доставляться');
  assert.equal(res.output.note, 'stale_branch_reverts_main');
  assert.deepEqual(res.output.deletedOutsideChangedSet, ['packages/app-switcher/index.js']);
  assert.equal(res.output.worktreeBranch, 'programmer/PROJECT_2/front_salesflow');
  assert.equal(res.output.tip, deliveredCommit);
  assert.ok(res.output.mergeBase, 'диагностика содержит mergeBase');

  // main НЕ откачен: HEAD прежний, файл main-а на месте, дельта ветки не доехала.
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), mainHeadBefore, 'main остаётся на прежнем HEAD');
  assert.doesNotThrow(
    () => git(dir, ['cat-file', '-e', 'main:packages/app-switcher/index.js']),
    'влитый в main файл не должен быть удалён',
  );
  assert.throws(() => git(dir, ['cat-file', '-e', 'main:feature.js']), 'дельта стухшей ветки не доехала до main');

  // autostash не потерян: дубль дельты сохранён в stash для ресинка/разбора.
  assert.notEqual(git(dir, ['stash', 'list']).trim(), '', 'autostash с дублем дельты должен сохраниться');
});

// GI-STALE-DELIVERED-ALREADY-IN-MAIN-001 (инцидент 13.07): у стухшей ветки дельту
// УЖЕ влил сиблинг/предыдущая задача. Ветку пересинхронизировали на актуальный main
// (rebase выкинул дельту как patch-equivalent) → branch == main, но записанный
// deliveredCommit «стух» (его нетто-дифф удалил бы новые файлы main). Раньше GI
// безусловно откатывался на этот SHA и зацикливался stale_branch_reverts_main, хотя
// доставлять НЕЧЕГО. Теперь: patch deliveredCommit уже в main (git cherry «-») →
// tip остаётся tip-ом ветки (== main) → already_integrated_content, main не тронут.
test('runGitAction: пересинканная ветка, дельта уже в main (стухший deliveredCommit) → already_integrated_content, не stale_branch', async (t) => {
  const dir = initRepo(t);

  // Ветка отходит от ДРЕВНЕГО main и несёт дельту feature.js (deliveredCommit «стухнет»).
  git(dir, ['checkout', '--quiet', '-b', 'programmer/PROJECT_2/PS-Torg-frontend']);
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: task delta']);
  const deliveredCommit = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']);

  // main УШЁЛ ВПЕРЁД двумя коммитами: (1) новый файл app-switcher, которого в стухшей
  // ветке нет; (2) ОТДЕЛЬНЫМ коммитом — ТА ЖЕ дельта feature.js (сиблинг доставил её
  // своим коммитом → patch-id совпадает с deliveredCommit, git cherry увидит «-»).
  // Нетто-дифф стухшего deliveredCommit относительно main удалил бы app-switcher
  // (stale_branch), но его патч (feature.js) уже присутствует в main.
  mkdirSync(path.join(dir, 'packages', 'app-switcher'), { recursive: true });
  writeFileSync(path.join(dir, 'packages', 'app-switcher', 'index.js'), 'export const app = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'main: app-switcher влит другой задачей']);
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n'); // тот же контент/дифф, влит сиблингом
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: task delta']); // patch-id == deliveredCommit
  const mainHead = git(dir, ['rev-parse', 'HEAD']).trim();

  // Ресинк: ветку пересинхронизировали на актуальный main (== rebase, выкинувший дельту).
  git(dir, ['branch', '-f', 'programmer/PROJECT_2/PS-Torg-frontend', 'main']);

  const res = await runGitAction(
    {
      id: 't-resync',
      title: 'PS-Torg frontend',
      worktreeBranch: 'programmer/PROJECT_2/PS-Torg-frontend',
      deliveredCommit,
      changedFiles: ['feature.js'],
    },
    { repoRoot: dir },
  );

  // Доставлять нечего (контент уже в main) — успех already_integrated_content, НЕ блок.
  assert.notEqual(res.output.note, 'stale_branch_reverts_main', 'не должно быть stale-блока: дельта уже в main');
  assert.equal(res.success, true, 'пересинканная ветка с уже влитой дельтой → успех');
  assert.equal(res.output.note, 'already_integrated_content');
  // main не откачен: app-switcher на месте, HEAD прежний.
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), mainHead, 'main остаётся на прежнем HEAD');
  assert.doesNotThrow(
    () => git(dir, ['cat-file', '-e', 'main:packages/app-switcher/index.js']),
    'влитый сиблингом файл не должен быть удалён стухшей доставкой',
  );
});

test('runGitAction: ветка удаляет файл ТОЛЬКО внутри своего changed-set → доставка проходит штатно', async (t) => {
  const dir = initRepo(t);

  // main содержит файл, который ветка легитимно удалит своей дельтой.
  writeFileSync(path.join(dir, 'obsolete.txt'), 'old\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'main: obsolete.txt']);
  const mainHeadBefore = git(dir, ['rev-parse', 'HEAD']).trim();

  // Ветка отходит от АКТУАЛЬНОГО main и удаляет obsolete.txt + добавляет feature.js.
  git(dir, ['checkout', '--quiet', '-b', 'programmer/PROJECT_2/front_salesflow']);
  git(dir, ['rm', '--quiet', 'obsolete.txt']);
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: удалить obsolete, добавить feature']);
  const deliveredCommit = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']);

  const res = await runGitAction(
    {
      id: 't-in-set',
      title: 'Cleanup',
      worktreeBranch: 'programmer/PROJECT_2/front_salesflow',
      deliveredCommit,
      changedFiles: ['obsolete.txt', 'feature.js'],
    },
    { repoRoot: dir },
  );

  // Удаление внутри changed-set — легитимная дельта: доставка проходит.
  assert.equal(res.success, true, 'удаление внутри changed-set не должно блокироваться предохранителем');
  assert.ok(res.output.commit, 'должен быть коммит интеграции в main');
  assert.notEqual(git(dir, ['rev-parse', 'HEAD']).trim(), mainHeadBefore, 'main продвинут дельтой');
  // Дельта реально в main: obsolete.txt удалён, feature.js добавлен.
  assert.throws(() => git(dir, ['cat-file', '-e', 'main:obsolete.txt']), 'obsolete.txt удалён из main');
  assert.doesNotThrow(() => git(dir, ['cat-file', '-e', 'main:feature.js']), 'feature.js добавлен в main');
});
