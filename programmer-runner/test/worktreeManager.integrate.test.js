// Git-смоук интеграции дельты worktree → основное дерево (грязный git-край,
// не покрываемый инъектируемыми юнит-тестами ProgrammerRunner).
//
// Регрессия PROGRAMMER-INTEGRATE-IDEMPOTENT-001: REWORK-заход, когда файлы
// первого прогона уже лежат в основном дереве (untracked), не должен падать
// integrate_conflict «already exists in working directory». Идентичное содержимое
// → идемпотентный успех; расходящееся → диагностируемый провал со списком файлов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktreeManager.js';

const silent = { warn() {}, info() {}, log() {}, error() {} };

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Пустой git-репозиторий с одним базовым коммитом (аналог основного дерева PS).
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-repo-'));
  git(dir, ['init', '--quiet']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'user.email', 'test@local']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']); // детерминизм содержимого вне зависимости от хоста
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'init']);
  return dir;
}

function newRoot() {
  return mkdtempSync(join(tmpdir(), 'wtm-root-'));
}

function cleanup(repo, root) {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* ок */ }
  try { rmSync(repo, { recursive: true, force: true }); } catch { /* ок */ }
}

// Записать файл (с созданием каталогов) в дерево dir.
function put(dir, rel, content) {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), content);
}

test('integrate: обычная сдача — новый файл применяется в основное дерево', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/README.md', 'hello\n');
    return { ok: true, result: { note: 'done' } };
  });
  assert.equal(res.ok, true, `ожидали успех, error=${res.error}`);
  assert.deepEqual(res.changedFiles, ['pkg/README.md']);
  assert.ok(!res.alreadyApplied, 'обычная сдача что-то применяет');
  assert.equal(readFileSync(join(repo, 'pkg/README.md'), 'utf8'), 'hello\n');
  cleanup(repo, root);
});

test('integrate: REWORK — патч уже донесён (untracked, то же содержимое) → успех без изменений', async () => {
  const repo = makeRepo();
  // Симулируем артефакт первого прогона: файл лежит в основном дереве untracked.
  put(repo, 'pkg/README.md', 'hello\n');
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/README.md', 'hello\n'); // то же содержимое, что уже в дереве
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `REWORK не должен падать, error=${res.error}`);
  assert.equal(res.alreadyApplied, true);
  // changedFiles отдаём даже при skip — Git Integrator подберёт untracked-артефакты.
  assert.deepEqual(res.changedFiles, ['pkg/README.md']);
  assert.equal(readFileSync(join(repo, 'pkg/README.md'), 'utf8'), 'hello\n');
  cleanup(repo, root);
});

test('integrate: REWORK с расходящимся содержимым → диагностируемый провал, дерево не тронуто', async () => {
  const repo = makeRepo();
  put(repo, 'pkg/README.md', 'DIFFERENT\n'); // чужие/другие изменения в основном дереве
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/README.md', 'hello\n');
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, false);
  assert.equal(res.conflict, true);
  assert.match(res.error, /pkg\/README\.md/, 'в сообщении есть конфликтующий файл');
  assert.doesNotMatch(res.error, /already exists in working directory/, 'не сырой stderr git apply');
  assert.deepEqual(res.conflictingFiles, ['pkg/README.md']);
  // Дерево не тронуто — прежнее содержимое на месте.
  assert.equal(readFileSync(join(repo, 'pkg/README.md'), 'utf8'), 'DIFFERENT\n');
  cleanup(repo, root);
});

test('integrate: смешанный REWORK — часть уже в дереве, часть новых → успех, недостающие применены', async () => {
  const repo = makeRepo();
  put(repo, 'pkg/a.txt', 'AAA\n'); // уже донесён первым прогоном (untracked)
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/a.txt', 'AAA\n'); // тот же
    put(wt, 'pkg/b.txt', 'BBB\n'); // новый
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `смешанный REWORK не должен падать, error=${res.error}`);
  assert.equal(res.alreadyApplied, false, 'часть файлов реально применена');
  assert.equal(readFileSync(join(repo, 'pkg/a.txt'), 'utf8'), 'AAA\n');
  assert.equal(readFileSync(join(repo, 'pkg/b.txt'), 'utf8'), 'BBB\n');
  cleanup(repo, root);
});
