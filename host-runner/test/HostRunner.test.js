import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HostRunner } from '../src/HostRunner.js';
import { runGitAction } from '../src/actions.js';

const silent = { info() {}, error() {}, warn() {} };

function fakeHttp(overrides = {}) {
  const calls = { claim: [], complete: [], release: [] };
  return {
    calls,
    claim: overrides.claim ?? (async (role) => { calls.claim.push(role); return { task: null }; }),
    complete: overrides.complete ?? (async (b) => { calls.complete.push(b); return { accepted: true }; }),
    release: overrides.release ?? (async (id) => { calls.release.push(id); return { released: true }; }),
  };
}

// tick() теперь fire-and-forget: возвращает статусы синхронно, а результат роли
// доступен через entry.promise. Хелпер дожидается результата по роли.
async function resultFor(out, role) {
  const entry = out.find((o) => o.role === role);
  return entry?.promise ? entry.promise : entry;
}

test('idle: нет задачи => нет complete/release', async () => {
  const http = fakeHttp();
  const runner = new HostRunner({ http, executors: { PIPELINE_SERVICE: async () => ({ success: true }) }, roles: ['PIPELINE_SERVICE'], log: silent });
  const res = await resultFor(runner.tick(), 'PIPELINE_SERVICE');
  assert.deepEqual(res, { role: 'PIPELINE_SERVICE', idle: true });
  assert.equal(http.calls.complete.length, 0);
});

test('успех: claim -> execute -> complete(success=true) с output', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't1', role: 'PIPELINE_SERVICE' } }) });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: true, output: { runId: 'r1' } }) },
    roles: ['PIPELINE_SERVICE'],
    log: silent,
  });
  const res = await resultFor(runner.tick(), 'PIPELINE_SERVICE');
  assert.deepEqual(res, { role: 'PIPELINE_SERVICE', taskId: 't1', success: true });
  assert.equal(http.calls.complete.length, 1);
  assert.deepEqual(http.calls.complete[0], { taskId: 't1', role: 'PIPELINE_SERVICE', success: true, output: { runId: 'r1' } });
  assert.equal(http.calls.release.length, 0);
});

test('вердикт-провал: complete(success=false), без release', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't2', role: 'PIPELINE_SERVICE' } }) });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: false, output: { failedStage: 'unit-tests' } }) },
    roles: ['PIPELINE_SERVICE'],
    log: silent,
  });
  await resultFor(runner.tick(), 'PIPELINE_SERVICE');
  assert.equal(http.calls.complete[0].success, false);
  assert.equal(http.calls.release.length, 0);
});

test('сбой исполнителя (throw): release задачи, без complete', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't3', role: 'GIT_INTEGRATOR' } }) });
  const runner = new HostRunner({
    http,
    executors: { GIT_INTEGRATOR: async () => { throw new Error('git boom'); } },
    roles: ['GIT_INTEGRATOR'],
    log: silent,
  });
  const res = await resultFor(runner.tick(), 'GIT_INTEGRATOR');
  assert.equal(res.error, 'git boom');
  assert.equal(http.calls.complete.length, 0);
  assert.deepEqual(http.calls.release, ['t3']);
});

test('обе роли опрашиваются за тик', async () => {
  const seen = [];
  const http = fakeHttp({ claim: async (role) => { seen.push(role); return { task: null }; } });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: true }), GIT_INTEGRATOR: async () => ({ success: true }) },
    log: silent,
  });
  const out = runner.tick();
  await Promise.all(out.map((o) => o.promise));
  // При параллельном опросе порядок недетерминирован — проверяем членство, не порядок.
  assert.deepEqual(new Set(seen), new Set(['PIPELINE_SERVICE', 'GIT_INTEGRATOR']));
});

test('per-role: повторный тик не входит в уже занятую роль (реэнтерабельность)', async () => {
  let active = 0;
  let maxActive = 0;
  const http = fakeHttp({
    claim: async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; return { task: null }; },
  });
  const runner = new HostRunner({ http, executors: { PIPELINE_SERVICE: async () => ({ success: true }) }, roles: ['PIPELINE_SERVICE'], log: silent });
  const first = runner.tick();
  // Пока действие роли в полёте — повторные тики должны её пропускать.
  assert.deepEqual(runner.tick().map((o) => ({ role: o.role, skipped: o.skipped })), [{ role: 'PIPELINE_SERVICE', skipped: 'busy' }]);
  assert.deepEqual(runner.tick().map((o) => ({ role: o.role, skipped: o.skipped })), [{ role: 'PIPELINE_SERVICE', skipped: 'busy' }]);
  await Promise.all(first.map((o) => o.promise));
  assert.equal(maxActive, 1);
});

test('приёмка: зависший PIPELINE_SERVICE не мешает GIT_INTEGRATOR пройти claim->execute->complete', async () => {
  let releasePipeline;
  const pipelineHang = new Promise((r) => { releasePipeline = r; });
  const http = fakeHttp({
    claim: async (role) => {
      if (role === 'PIPELINE_SERVICE') return { task: { id: 'p1', role } };
      if (role === 'GIT_INTEGRATOR') return { task: { id: 'g1', role } };
      return { task: null };
    },
  });
  const runner = new HostRunner({
    http,
    executors: {
      // Долгое действие: висит на незавершённом промисе (эмуляция docker build/up).
      PIPELINE_SERVICE: async () => { await pipelineHang; return { success: true, output: {} }; },
      GIT_INTEGRATOR: async () => ({ success: true, output: { merged: 'abc' } }),
    },
    log: silent,
  });

  const out = runner.tick();

  // GIT_INTEGRATOR завершается, пока PIPELINE_SERVICE ещё висит.
  const gitRes = await resultFor(out, 'GIT_INTEGRATOR');
  assert.deepEqual(gitRes, { role: 'GIT_INTEGRATOR', taskId: 'g1', success: true });
  assert.equal(http.calls.complete.length, 1);
  assert.deepEqual(http.calls.complete[0], { taskId: 'g1', role: 'GIT_INTEGRATOR', success: true, output: { merged: 'abc' } });

  // PIPELINE_SERVICE всё ещё в полёте: complete по нему не вызван, guard занят.
  assert.equal(runner.inFlight.has('PIPELINE_SERVICE'), true);

  // Отпускаем зависший pipeline и дожидаемся его завершения (чистка).
  releasePipeline();
  await resultFor(out, 'PIPELINE_SERVICE');
  assert.equal(http.calls.complete.length, 2);
});

// ── runGitAction: интеграция дельты программиста в main ───────────────────────
// Регресс к инциденту 05.07 (agent_runs): программист сдаёт код КОММИТОМ в ветку
// worktree (programmer/<project>/<service>), а GIT_INTEGRATOR раньше её не видел и
// закрывал задачу тихим SUCCESS с note no_changed_files/nothing_to_stage — код
// оставался только в ветке. Проверяем реальными git-эффектами во временном репо.

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Временный git-репозиторий с одним коммитом на ветке main и заданной identity.
function initRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gi-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.email', 'test@local']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'init']);
  git(dir, ['branch', '-M', 'main']); // имя ветки по умолчанию не зависит от версии git
  return dir;
}

test('runGitAction: сдача через worktree-ветку → дельта влита в main', async (t) => {
  const dir = initRepo(t);
  // Программист сдаёт дельту коммитом в отдельной ветке (эмуляция worktree).
  git(dir, ['checkout', '--quiet', '-b', 'programmer/PROJECT_2/host-runner']);
  writeFileSync(path.join(dir, 'feature.js'), 'export const x = 1;\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'programmer: task delta']);
  const deliveredCommit = git(dir, ['rev-parse', 'HEAD']).trim();
  git(dir, ['checkout', '--quiet', 'main']); // main пока БЕЗ feature.js

  const res = await runGitAction(
    {
      id: 't-wt',
      title: 'Widget feedback',
      worktreeBranch: 'programmer/PROJECT_2/host-runner',
      deliveredCommit,
      changedFiles: ['feature.js'],
    },
    { repoRoot: dir },
  );

  assert.equal(res.success, true);
  assert.ok(res.output.commit, 'должен быть коммит интеграции в main');
  // Дельта реально в main: файл закоммичен в ветке main, а не только в ветке программиста.
  assert.doesNotThrow(() => git(dir, ['cat-file', '-e', 'main:feature.js']));
  assert.equal(git(dir, ['show', 'main:feature.js']), 'export const x = 1;\n');
  assert.ok(git(dir, ['log', '--oneline', 'main']).includes('task delta'));
});

test('runGitAction: реально пустая сдача (нет ветки, пустой changedFiles) → success note no_changed_files', async (t) => {
  const dir = initRepo(t);
  const res = await runGitAction({ id: 't-empty', title: 'Nothing', changedFiles: [] }, { repoRoot: dir });
  assert.deepEqual(res, { success: true, output: { commit: null, files: [], note: 'no_changed_files' } });
});

test('runGitAction: заявленные изменения без реальной интеграции → FAILED empty_deliverable_declared_changes', async (t) => {
  const dir = initRepo(t);
  // changedFiles заявлен, но README.md не менялся → git не видит изменений (nothing_to_stage).
  const res = await runGitAction({ id: 't-decl', title: 'Declared', changedFiles: ['README.md'] }, { repoRoot: dir });
  assert.equal(res.success, false);
  assert.equal(res.output.note, 'empty_deliverable_declared_changes');
  assert.equal(res.output.reason, 'nothing_to_stage');
});
