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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
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
  // WORKTREE-DELIVERY-001: сдача несёт ветку worktree и SHA коммита дельты —
  // по ним GIT_INTEGRATION вливает код в main (git log в main), а не только в ветку.
  assert.equal(res.branch, 'programmer/PROJECT/SVC');
  assert.match(res.commit, /^[0-9a-f]{40}$/, 'commit — SHA коммита в ветке worktree');
  // Коммит реально существует в ветке worktree сервиса (его и вольёт GI).
  const head = git(join(root, 'PROJECT_SVC'), ['rev-parse', 'HEAD']).trim();
  assert.equal(res.commit, head);
  cleanup(repo, root);
});

test('integrate: пустая дельта (агент ничего не изменил) → branch есть, commit=null, changedFiles пуст', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async () => {
    // Ничего не пишем в worktree — сдача без изменений кода.
    return { ok: true, result: { note: 'noop' } };
  });
  assert.equal(res.ok, true, `пустая сдача — валидный исход, error=${res.error}`);
  assert.deepEqual(res.changedFiles, []);
  // Ветку сервиса всё равно отдаём (GI отличит пустую сдачу), коммита дельты нет.
  assert.equal(res.branch, 'programmer/PROJECT/SVC');
  assert.equal(res.commit, null);
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

// Регрессия WORKTREE-SYNC-MAIN-001 (инцидент 09.07, CHAT): ветка сервиса живёт
// столько же, сколько процесс раннера, а main уезжает вперёд — следующая задача
// правит устаревшее содержимое, и её дельта падает integrate_conflict. После
// того как дельта ветки влита в main, ветка перед новой задачей должна
// освежиться от main (reset на HEAD), чтобы агент работал на актуальной базе.
test('sync: дельта ветки влита в main, main уехал вперёд → ветка освежается, задача ложится', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1: создаёт файл; дельта применяется в основное дерево (untracked).
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // GI влил дельту в main (тот же патч → тот же patch-id, git cherry увидит '-').
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'gi: task 1']);
  // main уехал вперёд: файл изменён другим потоком (ручной merge/другая задача).
  writeFileSync(join(repo, 'pkg/f.txt'), 'v1-main\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'main moved']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  // Задача 2: правит файл ОТ ТЕКУЩЕГО содержимого worktree. Без освежения база —
  // протухшее 'v1' → дельта не легла бы на main (integrate_conflict).
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    const cur = readFileSync(join(wt, 'pkg/f.txt'), 'utf8');
    writeFileSync(join(wt, 'pkg/f.txt'), `${cur}v2\n`);
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после освежения дельта ложится, error=${res2.error}`);
  assert.equal(readFileSync(join(repo, 'pkg/f.txt'), 'utf8'), 'v1-main\nv2\n', 'main: и уехавшее содержимое, и дельта задачи 2');
  // Ветка реально пересажена на свежий main (его HEAD — предок ветки).
  const onFreshBase = git(join(root, 'PROJECT_SVC'), ['merge-base', '--is-ancestor', mainHead, 'HEAD']);
  assert.equal(onFreshBase, '', 'ветка сервиса растёт от свежего HEAD main');
  cleanup(repo, root);
});

test('sync: неинтегрированная дельта в ветке → освежение пропускается, накопленное сохраняется', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1 сдана, но GI её ещё НЕ вливал (в main untracked-дубль, HEAD без неё).
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // main уехал вперёд по ДРУГОМУ файлу.
  writeFileSync(join(repo, 'other.txt'), 'other\n');
  git(repo, ['add', '--', 'other.txt']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'unrelated']);
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    // Накопленное worktree на месте — сброс не должен был случиться.
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'невлитая дельта задачи 1 сохранена');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `вторая сдача, error=${res2.error}`);
  // Коммит невлитой дельты по-прежнему в ветке (его вольёт GI).
  const kept = git(join(root, 'PROJECT_SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
  assert.equal(kept, '', 'коммит первой сдачи не потерян при пропуске освежения');
  cleanup(repo, root);
});

// Регрессия WORKTREE-REUSE-001 (инцидент 09.07, frontend): рестарт раннера
// (вотчдог свежести) пересоздавал worktree от HEAD с branch -D — коммиты дельт,
// сданных, но ещё не влитых GI в main, исчезали из ветки, а их содержимое
// оставалось грязью в основном дереве → все побайтовые сверки расходились и
// конвейер сервиса клинило. Новый экземпляр менеджера обязан прицепиться к
// существующей ветке, не теряя её коммиты.
test('restart: новый менеджер переиспользует worktree/ветку с невлитой дельтой', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr1 = new WorktreeManager({ root, log: silent });
  // Задача 1 сдана, GI ещё НЕ вливал: дельта живёт коммитом в ветке + untracked в main.
  const res1 = await mgr1.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // «Рестарт раннера»: новый экземпляр с пустой картой сервисов.
  const mgr2 = new WorktreeManager({ root, log: silent });
  const res2 = await mgr2.runForService(repo, 'PROJECT:SVC', async (wt) => {
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'невлитая дельта пережила рестарт');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после рестарта, error=${res2.error}`);
  const kept = git(join(root, 'PROJECT_SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
  assert.equal(kept, '', 'коммит невлитой дельты не потерян рестартом');
  cleanup(repo, root);
});

test('restart: каталог worktree утерян (tmp почищен) → worktree поднимается на существующей ветке', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr1 = new WorktreeManager({ root, log: silent });
  const res1 = await mgr1.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // tmp зачищен между запусками — каталога worktree больше нет, ветка в репо есть.
  rmSync(join(root, 'PROJECT_SVC'), { recursive: true, force: true });
  const mgr2 = new WorktreeManager({ root, log: silent });
  const res2 = await mgr2.runForService(repo, 'PROJECT:SVC', async (wt) => {
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'ветка с дельтой поднята в новый каталог');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после потери каталога, error=${res2.error}`);
  const kept = git(join(root, 'PROJECT_SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
  assert.equal(kept, '', 'коммит невлитой дельты не потерян');
  cleanup(repo, root);
});

test('restart: недокоммиченный мусор убитого прогона сбрасывается, коммиты ветки целы', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr1 = new WorktreeManager({ root, log: silent });
  const res1 = await mgr1.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // Прогон убит на середине: в worktree остались незакоммиченные правки.
  put(join(root, 'PROJECT_SVC'), 'pkg/halfdone.txt', 'garbage\n');
  writeFileSync(join(root, 'PROJECT_SVC', 'pkg/f.txt'), 'mangled\n');
  const mgr2 = new WorktreeManager({ root, log: silent });
  const res2 = await mgr2.runForService(repo, 'PROJECT:SVC', async (wt) => {
    assert.equal(existsSync(join(wt, 'pkg/halfdone.txt')), false, 'мусор убитого прогона сброшен');
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'закоммиченная дельта восстановлена');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после сброса мусора, error=${res2.error}`);
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
