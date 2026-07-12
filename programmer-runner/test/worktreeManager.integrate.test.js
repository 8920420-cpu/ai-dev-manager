// Git-смоук изоляции дельты worktree (грязный git-край, не покрываемый
// инъектируемыми юнит-тестами ProgrammerRunner).
//
// WORKTREE-ISOLATE-DELIVERY-001: Программист БОЛЬШЕ НЕ пишет в общее рабочее дерево
// репозитория. Дельта задачи живёт ТОЛЬКО коммитом в изолированной ветке сервиса
// (programmer/<project>/<service>); TESTING гоняется на checkout этой ветки
// (host-runner), а в main её вливает Git Integrator. Раньше дельта дополнительно
// накатывалась незакоммиченной в общее дерево (`git apply` в repoCwd) и при недоходе
// до GI копилась/терялась — этот накат убран. Тесты проверяют инвариант «общее дерево
// чистое» + сохранность дельты в ветке, освежение ветки от main и сохранность
// невлитых веток при остановке процесса.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/worktreeManager.js';

const silent = { warn() {}, info() {}, log() {}, error() {} };

// Git-переменные окружения РОДИТЕЛЬСКОГО процесса (GIT_DIR, GIT_WORK_TREE,
// GIT_INDEX_FILE и пр. worktree-контекст) навязали бы каждой `git -C <tmp>` внешний
// репозиторий-checkout вместо свежесозданного temp-репо: `git commit` тогда
// исполнялся бы в дереве пайплайна («nothing to commit / ahead of origin/main»), а не
// в тестовом repo. Пайплайн гоняет раннер внутри git-хука (post-commit/post-merge),
// который эти переменные экспортирует. Чистим их, чтобы тест был изолирован от того,
// где именно его запустили.
const CLEAN_GIT_ENV = (() => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|COMMON_DIR|NAMESPACE|PREFIX|CEILING_DIRECTORIES|ALTERNATE_OBJECT_DIRECTORIES)$/.test(k)) {
      delete env[k];
    }
  }
  return env;
})();

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: CLEAN_GIT_ENV });
}

// SHA ветки в репозитории или '' (без throw), для проверок наличия ветки.
function branchSha(repo, branch) {
  try { return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim(); } catch { return ''; }
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

// Каталог worktree сервиса внутри root (sanitize ключа сервиса: ':' → '_').
function wtDir(root, serviceKey) {
  return join(root, serviceKey.replace(/[^A-Za-z0-9_.-]/g, '_'));
}

test('обычная сдача: дельта коммитится в ветку сервиса, общее дерево НЕ трогается', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/README.md', 'hello\n');
    return { ok: true, result: { note: 'done' } };
  });
  assert.equal(res.ok, true, `ожидали успех, error=${res.error}`);
  assert.deepEqual(res.changedFiles, ['pkg/README.md']);
  // WORKTREE-DELIVERY-001: сдача несёт ветку worktree и SHA коммита дельты — по ним
  // Pipeline Service тестирует ветку, а GIT_INTEGRATION вливает её в main.
  assert.equal(res.branch, 'programmer/PROJECT/SVC');
  assert.match(res.commit, /^[0-9a-f]{40}$/, 'commit — SHA коммита дельты в ветке worktree');
  // Дельта реально в ветке worktree сервиса (её и тестирует/вольёт конвейер).
  const wt = wtDir(root, 'PROJECT:SVC');
  assert.equal(git(wt, ['rev-parse', 'HEAD']).trim(), res.commit);
  assert.equal(readFileSync(join(wt, 'pkg/README.md'), 'utf8'), 'hello\n');
  // WORKTREE-ISOLATE-DELIVERY-001: общее дерево репозитория ЧИСТОЕ — Программист в
  // него больше ничего не пишет (ни tracked, ни untracked).
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'общее дерево не тронуто Программистом');
  assert.equal(existsSync(join(repo, 'pkg/README.md')), false, 'файла нет в общем дереве');
  cleanup(repo, root);
});

test('пустая дельта (агент ничего не изменил) → branch есть, commit=null, changedFiles пуст', async () => {
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
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'общее дерево чистое');
  cleanup(repo, root);
});

test('изоляция: предсуществующий untracked в общем дереве НЕ влияет — дельта коммитится в ветку', async () => {
  const repo = makeRepo();
  // Чужой untracked-файл в общем дереве (раньше провоцировал ложный integrate_conflict).
  put(repo, 'pkg/README.md', 'OLD-UNTRACKED\n');
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/README.md', 'hello\n'); // содержимое отличается от того, что в общем дереве
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `изоляция: успех независимо от общего дерева, error=${res.error}`);
  assert.equal(res.conflict, undefined, 'конфликтов на стадии Программиста больше нет');
  assert.deepEqual(res.changedFiles, ['pkg/README.md']);
  assert.match(res.commit, /^[0-9a-f]{40}$/);
  // Дельта — в ветке worktree, а общее дерево Программист не трогал: там ровно то, что лежало.
  assert.equal(readFileSync(join(wtDir(root, 'PROJECT:SVC'), 'pkg/README.md'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(repo, 'pkg/README.md'), 'utf8'), 'OLD-UNTRACKED\n', 'общее дерево не тронуто');
  cleanup(repo, root);
});

// Регрессия WORKTREE-SYNC-MAIN-001 (инцидент 09.07, CHAT): ветка сервиса живёт
// столько же, сколько процесс раннера, а main уезжает вперёд — следующая задача
// правит устаревшее содержимое, и её дельта падает конфликтом при вливании. После
// того как дельта ветки влита в main, ветка перед новой задачей должна освежиться
// от main (reset на HEAD), чтобы агент работал на актуальной базе.
test('sync: дельта ветки влита в main, main уехал вперёд → ветка освежается, задача ложится', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1: создаёт файл в ветке worktree (общее дерево не трогается).
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // GI влил дельту в main тем же содержимым → тот же patch-id (git cherry увидит '-').
  put(repo, 'pkg/f.txt', 'v1\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'gi: task 1']);
  // main уехал вперёд: файл изменён другим потоком (ручной merge/другая задача).
  writeFileSync(join(repo, 'pkg/f.txt'), 'v1-main\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'main moved']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  // Задача 2: правит файл ОТ ТЕКУЩЕГО содержимого worktree. Без освежения база —
  // протухшее 'v1' → дельта не легла бы на main (конфликт при вливании).
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    const cur = readFileSync(join(wt, 'pkg/f.txt'), 'utf8');
    writeFileSync(join(wt, 'pkg/f.txt'), `${cur}v2\n`);
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после освежения дельта ложится, error=${res2.error}`);
  const wt = wtDir(root, 'PROJECT:SVC');
  assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1-main\nv2\n', 'ветка: уехавшее содержимое main + дельта задачи 2');
  // Ветка реально пересажена на свежий main (его HEAD — предок ветки).
  const onFreshBase = git(wt, ['merge-base', '--is-ancestor', mainHead, 'HEAD']);
  assert.equal(onFreshBase, '', 'ветка сервиса растёт от свежего HEAD main');
  cleanup(repo, root);
});

test('sync: неинтегрированная дельта в ветке → освежение пропускается, накопленное сохраняется', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1 сдана, но GI её ещё НЕ вливал (main HEAD её не содержит).
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
  const kept = git(wtDir(root, 'PROJECT:SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
  assert.equal(kept, '', 'коммит первой сдачи не потерян при пропуске освежения');
  cleanup(repo, root);
});

// Регрессия WORKTREE-SYNC-MAIN-001 (регрессия коммита 4986587, разбор застрявшей
// задачи bbd7cc03): сервисная ветка разошлась с main давно (древний merge-base), а
// main уехал далеко вперёд, добавив файлы, которых ветка не видит. Нетто-дифф
// доставки такой ветки (`git diff main..tip`) УДАЛИЛ БЫ эти файлы из main —
// форс-доставка отревертила бы влитую работу. Перед переиспользованием под новую
// задачу стухшую ветку обязаны БЕЗУСЛОВНО пересадить на актуальный main (hard-reset),
// чтобы дельта считалась от свежей базы и не тащила стухшую историю.
test('sync: стухшая ветка (древний merge-base, нетто-дифф удаляет файлы main вне changed-set) ресетится на актуальный main', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent, staleForeignDeletionLimit: 5 });
  // Задача 1: ветка сервиса форкается от древнего base и добавляет свой файл.
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/old.txt', 'old\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // main УЕХАЛ ДАЛЕКО вперёд: другие потоки добавили в main целые поддеревья
  // (packages/app-switcher/* из инцидента), которых древняя ветка не видит.
  for (let i = 0; i < 12; i++) put(repo, `packages/app-switcher/f${i}.ts`, `export const f${i} = ${i};\n`);
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'main: массивная работа после развилки']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  // Задача 2 переиспользует ту же ветку. Нетто-дифф ветки удалил бы 12 файлов
  // app-switcher (вне её реальной работы) → ветка стухшая → БЕЗУСЛОВНЫЙ hard-sync.
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    // Ветка пересажена на актуальный main: файлы main видны, стухшего old.txt нет.
    assert.equal(existsSync(join(wt, 'packages/app-switcher/f0.ts')), true, 'после ресинка видны файлы актуального main');
    assert.equal(existsSync(join(wt, 'pkg/old.txt')), false, 'стухший файл ветки убран ресинком');
    put(wt, 'src/new.ts', 'export const n = 1;\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после ресинка задача ложится, error=${res2.error}`);
  assert.deepEqual(res2.changedFiles, ['src/new.ts'], 'дельта задачи 2 — только её новый файл');
  const wt = wtDir(root, 'PROJECT:SVC');
  // Ветка растёт от актуального HEAD main — стухших коммитов в дельте нет.
  assert.equal(git(wt, ['merge-base', '--is-ancestor', mainHead, 'HEAD']), '', 'ветка сервиса растёт от актуального main');
  // Нетто-дифф ветки против main больше НЕ удаляет посторонних файлов main.
  const netStatus = git(repo, ['diff', '--name-status', `${mainHead}..${res2.commit}`])
    .split('\n').map((l) => l.trim()).filter(Boolean);
  assert.equal(netStatus.filter((l) => l.startsWith('D')).length, 0, 'нетто-дифф не удаляет файлы main');
  cleanup(repo, root);
});

// Контрпример: настоящая аддитивная неинтегрированная дельта (ветка чуть отстала —
// main отъехал по паре ДРУГИХ файлов, обычный дрейф ниже порога стухлости) НЕ
// сбрасывается: сданная, но ещё не влитая GI работа должна пережить синхронизацию.
test('sync: аддитивная неинтегрированная дельта (дрейф ниже порога) НЕ ресетится', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent, staleForeignDeletionLimit: 5 });
  // Задача 1 сдана, GI ещё НЕ вливал — аддитивная неинтегрированная дельта.
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // main чуть отъехал по паре ДРУГИХ файлов — 2 постороннних удаления < порога 5.
  put(repo, 'other1.txt', 'o1\n');
  put(repo, 'other2.txt', 'o2\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'main: небольшой дрейф']);
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    // Невлитая дельта задачи 1 НА МЕСТЕ — стухлого ресинка не случилось.
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'аддитивная неинтегрированная дельта сохранена');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `вторая сдача, error=${res2.error}`);
  // Коммит невлитой (аддитивной) дельты не потерян ресинком.
  const kept = git(wtDir(root, 'PROJECT:SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
  assert.equal(kept, '', 'коммит первой (аддитивной) сдачи не сброшен');
  cleanup(repo, root);
});

// Регрессия WORKTREE-REUSE-001 (инцидент 09.07, frontend): рестарт раннера
// (вотчдог свежести) пересоздавал worktree от HEAD с branch -D — коммиты дельт,
// сданных, но ещё не влитых GI в main, исчезали из ветки. Новый экземпляр менеджера
// обязан прицепиться к существующей ветке, не теряя её коммиты.
test('restart: новый менеджер переиспользует worktree/ветку с невлитой дельтой', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr1 = new WorktreeManager({ root, log: silent });
  // Задача 1 сдана, GI ещё НЕ вливал: дельта живёт коммитом в ветке.
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
  const kept = git(wtDir(root, 'PROJECT:SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
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
  rmSync(wtDir(root, 'PROJECT:SVC'), { recursive: true, force: true });
  const mgr2 = new WorktreeManager({ root, log: silent });
  const res2 = await mgr2.runForService(repo, 'PROJECT:SVC', async (wt) => {
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'ветка с дельтой поднята в новый каталог');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после потери каталога, error=${res2.error}`);
  const kept = git(wtDir(root, 'PROJECT:SVC'), ['merge-base', '--is-ancestor', res1.commit, 'HEAD']);
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
  const wt = wtDir(root, 'PROJECT:SVC');
  put(wt, 'pkg/halfdone.txt', 'garbage\n');
  writeFileSync(join(wt, 'pkg/f.txt'), 'mangled\n');
  const mgr2 = new WorktreeManager({ root, log: silent });
  const res2 = await mgr2.runForService(repo, 'PROJECT:SVC', async (w) => {
    assert.equal(existsSync(join(w, 'pkg/halfdone.txt')), false, 'мусор убитого прогона сброшен');
    assert.equal(readFileSync(join(w, 'pkg/f.txt'), 'utf8'), 'v1\n', 'закоммиченная дельта восстановлена');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после сброса мусора, error=${res2.error}`);
  cleanup(repo, root);
});

// WORKTREE-ISOLATE-DELIVERY-001: ветка сервиса — ЕДИНСТВЕННАЯ копия дельты (в общее
// дерево накат убран), поэтому cleanupAll на остановке процесса НЕ имеет права
// force-удалять НЕВЛИТУЮ ветку — иначе сданная, но ещё не влитая GI работа теряется.
test('cleanup: невлитая ветка сохраняется, полностью влитая — удаляется', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `сдача, error=${res.error}`);
  // Дельта НЕ влита в main → cleanupAll обязан сохранить ветку.
  mgr.cleanupAll(new Map([['PROJECT:SVC', repo]]));
  assert.equal(branchSha(repo, 'programmer/PROJECT/SVC'), res.commit, 'невлитая ветка сохранена целиком');

  // Другой сервис с пустой (полностью влитой: tip == main HEAD) дельтой — ветка удаляется.
  const mgr2 = new WorktreeManager({ root, log: silent });
  const resEmpty = await mgr2.runForService(repo, 'PROJECT:DONE', async () => ({ ok: true, result: {} }));
  assert.equal(resEmpty.commit, null, 'пустая дельта');
  mgr2.cleanupAll(new Map([['PROJECT:DONE', repo]]));
  assert.equal(branchSha(repo, 'programmer/PROJECT/DONE'), '', 'влитая (пустая) ветка удалена');
  cleanup(repo, root);
});

// Регрессия WORKTREE-REPO-LOCK-001 (инцидент 09.07): при concurrency>1 разные
// сервисы входят в ensureWorktree одновременно, и глобальные для репо команды
// (`worktree prune`, `branch -D`, `worktree add`) гонятся — prune одного сносит
// полусозданную admin-запись другого → `worktree add` падает «Unable to create
// '<dir>/.git/index.lock': No such file or directory» (ENOENT). Шторм увёл 8 задач
// в BLOCKED (programmer_release_loop). Структурные операции сериализуются по
// репозиторию (withRepoLock) — параллельное создание worktree не должно падать.
test('concurrency: параллельное создание worktree разных сервисов одного репо не гонится', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const services = ['SVC_A', 'SVC_B', 'SVC_C', 'SVC_D', 'SVC_E', 'SVC_F'];
  // Все сервисы стартуют «с нуля» одновременно (пустая карта → чистое создание с
  // prune/branch -D/add) — ровно тот путь, что гонялся в инциденте.
  const results = await Promise.all(services.map((s) =>
    mgr.runForService(repo, `PROJECT:${s}`, async (wt) => {
      put(wt, `pkg/${s}.txt`, `${s}\n`);
      return { ok: true, result: {} };
    })));
  for (let i = 0; i < services.length; i++) {
    assert.equal(results[i].ok, true,
      `сервис ${services[i]} не должен падать worktree_ensure_failed: ${results[i].error}`);
    assert.doesNotMatch(String(results[i].error || ''), /index\.lock|worktree_ensure_failed/,
      'нет гонки prune/add');
  }
  // Дельта каждого сервиса — в его ветке worktree; общее дерево репозитория чистое.
  for (const s of services) {
    assert.equal(readFileSync(join(wtDir(root, `PROJECT:${s}`), `pkg/${s}.txt`), 'utf8'), `${s}\n`);
  }
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'общее дерево не тронуто Программистом');
  cleanup(repo, root);
});

// PROGRAMMER-DELTA-DENYLIST-001: артефакты сборки/генерации (напр. *.tsbuildinfo)
// исключаются из дельты программиста — они регенерируются и дают ложный конфликт
// при вливании. Легитимный исходник рядом с ними попадает в дельту как обычно.
test('deny-list: артефакт сборки исключён из дельты, исходник рядом попадает в дельту', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'src/app.ts', 'export const x = 1;\n');            // исходник — в дельте
    put(wt, 'tsconfig.tsbuildinfo', '{"version":"5.0"}\n');    // артефакт — исключается
    put(wt, 'dist/app.js', 'var x=1;\n');                       // build-вывод — исключается
    put(wt, 'node_modules/dep/index.js', 'module.exports=1;\n'); // deps — исключается
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `ожидали успех, error=${res.error}`);
  assert.deepEqual(res.changedFiles, ['src/app.ts'], 'в дельте (коммите ветки) только исходник');
  // Исходник реально закоммичен в ветку; артефакты в коммит-дельту не попали.
  assert.equal(readFileSync(join(wtDir(root, 'PROJECT:SVC'), 'src/app.ts'), 'utf8'), 'export const x = 1;\n');
  assert.equal(git(repo, ['status', '--porcelain']).trim(), '', 'общее дерево чистое');
  cleanup(repo, root);
});

test('deny-list: задача трогает ТОЛЬКО артефакты → пустая дельта (commit=null), а не ложный конфликт', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'tsconfig.tsbuildinfo', '{"v":1}\n');
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `пустая после фильтра дельта — валидный исход, error=${res.error}`);
  assert.deepEqual(res.changedFiles, []);
  assert.equal(res.commit, null, 'нечего коммитить — commit=null');
  cleanup(repo, root);
});

test('deny-list: сегментное совпадение не задевает похожие имена (distributor.ts ≠ dist)', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'src/distributor.ts', 'export const d = 1;\n'); // содержит "dist" как подстроку — НЕ артефакт
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `ожидали успех, error=${res.error}`);
  assert.deepEqual(res.changedFiles, ['src/distributor.ts'], 'файл с подстрокой dist не исключён');
  cleanup(repo, root);
});

test('deny-list: настраиваемый список через denyGlobs (кастомный артефакт исключён)', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent, denyGlobs: ['*.gen.go', 'generated'] });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'api/user.go', 'package api\n');          // исходник — в дельте
    put(wt, 'api/user.gen.go', 'package api // gen\n'); // *.gen.go — исключается
    put(wt, 'generated/schema.go', 'package generated\n'); // сегмент generated — исключается
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `ожидали успех, error=${res.error}`);
  assert.deepEqual(res.changedFiles, ['api/user.go']);
  cleanup(repo, root);
});

// Регрессия WORKTREE-GIT-ENV-ISOLATE-001 (FAILURE_ANALYST): пайплайн запускает
// раннер ВНУТРИ git-хука (post-commit/post-merge), который экспортирует контекст
// СВОЕГО репозитория (GIT_DIR/GIT_WORK_TREE/...). Production-хелпер git() наследовал
// это окружение, поэтому `git -C <целевой репо>` фактически бил по внешнему репо
// хука: `worktree add -b <branch>` спотыкался о его одноимённую ветку
// («fatal: a branch named ... already exists»), а коммит уходил бы в дерево пайплайна,
// а не в worktree сервиса. Все git-команды менеджера обязаны работать строго в
// переданном им репозитории, игнорируя внешний git-контекст окружения.
test('git-env: наследованный GIT_DIR/GIT_WORK_TREE внешнего репо не сбивает менеджер', async () => {
  // «Внешний» репо — как дерево пайплайна в момент срабатывания хука. В нём УЖЕ
  // есть одноимённая ветка сервиса — ровно то, обо что спотыкался `worktree add -b`
  // при наследовании GIT_DIR (fatal: branch already exists).
  const outer = makeRepo();
  git(outer, ['branch', 'programmer/PROJECT/SVC']);
  const outerGitDir = git(outer, ['rev-parse', '--absolute-git-dir']).trim();

  const repo = makeRepo();
  const root = newRoot();
  // Пачкаем process.env git-контекстом внешнего репо (production git() читает его).
  // Тестовый хелпер git() пользуется CLEAN_GIT_ENV (снимок на загрузке модуля), так
  // что проверки ниже остаются изолированными от этой правки.
  const saved = { dir: process.env.GIT_DIR, wt: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = outerGitDir;
  process.env.GIT_WORK_TREE = outer;
  try {
    const mgr = new WorktreeManager({ root, log: silent });
    const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
      put(wt, 'pkg/README.md', 'hello\n');
      return { ok: true, result: {} };
    });
    assert.equal(res.ok, true, `наследованный GIT_DIR не должен ронять менеджер, error=${res.error}`);
    assert.deepEqual(res.changedFiles, ['pkg/README.md']);
    assert.match(res.commit, /^[0-9a-f]{40}$/);
    // Дельта ушла в ЦЕЛЕВОЙ репо (его worktree), а не во «внешний» из GIT_DIR.
    assert.equal(readFileSync(join(wtDir(root, 'PROJECT:SVC'), 'pkg/README.md'), 'utf8'), 'hello\n');
    // Внешний репо не тронут: его дерево чистое, его одноимённая ветка на месте.
    assert.equal(git(outer, ['status', '--porcelain']).trim(), '', 'внешний репо не тронут');
    assert.notEqual(branchSha(outer, 'programmer/PROJECT/SVC'), '', 'ветка внешнего репо не перезаписана');
  } finally {
    if (saved.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = saved.dir;
    if (saved.wt === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = saved.wt;
  }
  cleanup(repo, root);
  try { rmSync(outer, { recursive: true, force: true }); } catch { /* ок */ }
});

test('изоляция: и предсуществующий, и новый файл — оба в дельте ветки, общее дерево не трогается', async () => {
  const repo = makeRepo();
  put(repo, 'pkg/a.txt', 'AAA\n'); // предсуществующий untracked в общем дереве
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const res = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/a.txt', 'AAA\n'); // тот же
    put(wt, 'pkg/b.txt', 'BBB\n'); // новый
    return { ok: true, result: {} };
  });
  assert.equal(res.ok, true, `error=${res.error}`);
  assert.deepEqual([...res.changedFiles].sort(), ['pkg/a.txt', 'pkg/b.txt'], 'оба файла в дельте ветки');
  const wt = wtDir(root, 'PROJECT:SVC');
  assert.equal(readFileSync(join(wt, 'pkg/a.txt'), 'utf8'), 'AAA\n');
  assert.equal(readFileSync(join(wt, 'pkg/b.txt'), 'utf8'), 'BBB\n');
  // Общее дерево: лишь ранее лежавший там a.txt; b.txt Программист туда не писал.
  assert.equal(existsSync(join(repo, 'pkg/b.txt')), false, 'нового файла нет в общем дереве');
  cleanup(repo, root);
});
