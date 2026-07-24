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

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
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

// WORKTREE-REBASE-STALE-001 (инцидент 23.07): ветка с НЕВЛИТОЙ дельтой на ПРОТУХШЕЙ
// базе (main ушёл вперёд, содержимое файлов расходится) раньше НЕ освежалась — агент
// правил устаревшее содержимое, и дельта падала при вливании (cherry_pick_failed /
// stale_branch_reverts_main). Теперь дельта ПЕРЕБАЗИРУЕТСЯ на свежий main (коммиты
// сохраняются), а не остаётся на древней базе.
test('sync: неинтегрированная дельта + main уехал → ветка перебазируется на свежий main, дельта сохранена', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1 сдана, но GI её ещё НЕ вливал (main HEAD её не содержит).
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    put(wt, 'pkg/f.txt', 'v1\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // main уехал вперёд по ДРУГОМУ файлу (частый случай: другой сервис влил дельту).
  writeFileSync(join(repo, 'other.txt'), 'other\n');
  git(repo, ['add', '--', 'other.txt']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'unrelated']);
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    // Невлитая дельта сохранена (rebase её перенёс), а база теперь свежая — файл,
    // уехавший в main, виден в worktree (раньше его тут не было — база тухла).
    assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'невлитая дельта задачи 1 сохранена');
    assert.equal(readFileSync(join(wt, 'other.txt'), 'utf8'), 'other\n', 'ветка на свежей базе main');
    put(wt, 'pkg/g.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `вторая сдача, error=${res2.error}`);
  const wt = wtDir(root, 'PROJECT:SVC');
  // Ветка растёт от свежего main (его HEAD — предок ветки), дельта задачи 1 (по
  // содержимому) в ней сохранена — GI вольёт её диапазоном merge-base..tip.
  const onFreshBase = git(wt, ['merge-base', '--is-ancestor', mainHead, 'HEAD']);
  assert.equal(onFreshBase, '', 'ветка сервиса на свежей базе main после rebase');
  assert.equal(readFileSync(join(wt, 'pkg/f.txt'), 'utf8'), 'v1\n', 'дельта задачи 1 сохранена в ветке');
  cleanup(repo, root);
});

// WORKTREE-REBASE-STALE-001: если rebase на свежий main КОНФЛИКТУЕТ (ветка и main
// правят одни строки), синк делает rebase --abort и остаётся на текущей базе —
// прежнее поведение, дельта не теряется, дерево не залипает в mid-rebase.
test('sync: rebase-конфликт → abort, работаем на текущей базе, дельта не потеряна', async () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  // Задача 1 правит base.txt в ветке (не влита).
  const res1 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    writeFileSync(join(wt, 'base.txt'), 'branch-change\n');
    return { ok: true, result: {} };
  });
  assert.equal(res1.ok, true, `первая сдача, error=${res1.error}`);
  // main меняет ТОТ ЖЕ файл иначе → rebase дельты на main конфликтует.
  writeFileSync(join(repo, 'base.txt'), 'main-change\n');
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'main touches base.txt']);
  const res2 = await mgr.runForService(repo, 'PROJECT:SVC', async (wt) => {
    // rebase не удался (конфликт по base.txt) → abort, база прежняя, дельта цела.
    assert.equal(readFileSync(join(wt, 'base.txt'), 'utf8'), 'branch-change\n', 'дельта сохранена после abort');
    put(wt, 'pkg/h.txt', 'v2\n');
    return { ok: true, result: {} };
  });
  assert.equal(res2.ok, true, `после abort вторая сдача проходит (дерево не в mid-rebase), error=${res2.error}`);
  assert.deepEqual(res2.changedFiles, ['pkg/h.txt']);
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

// Регрессия WORKTREE-ENSURE-STALE-BRANCH-001 (инцидент 24.07, CRM/Chat_Service):
// при ручном перезапуске задачи со СТУХШЕЙ существующей веткой reattach иногда не
// мог переиспользовать worktree (в проде — racy `index.lock: No such file or
// directory` от гонки prune), и всё падало на clean-path. Прежний clean-path делал
// `branch -D` + `worktree add -b`: (а) ТЕРЯЛ невлитую дельту ветки и (б) при
// не-удалённой ветке падал «branch already exists» → шторм worktree_ensure_failed →
// programmer_release_loop (задача 22 минуты клеймилась/освобождалась). Теперь
// clean-path переиспользует существующую ветку (add без -b), дельта сохраняется.
test('stale-branch: clean-path (reattach провалился) переиспользует существующую ветку, не падает -b, дельта цела', () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const branch = 'programmer/PROJECT/SVC';
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  // Готовим стухшую ветку с НЕВЛИТОЙ дельтой (её tip уехал вперёд main), затем
  // убираем её worktree — остаётся только ветка в репозитории, как после 23.07.
  const seed = join(root, 'seed');
  git(repo, ['worktree', 'add', '--quiet', '-b', branch, seed, 'HEAD']);
  writeFileSync(join(seed, 'delta.txt'), 'delta\n');
  git(seed, ['add', '-A']);
  git(seed, ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--quiet', '-m', 'unmerged delta']);
  const branchTip = git(seed, ['rev-parse', 'HEAD']).trim();
  git(repo, ['worktree', 'remove', '--force', seed]);
  assert.notEqual(branchTip, mainHead, 'ветка несёт невлитый коммит поверх main');
  // Симулируем racy-провал reattach: он вернул null, и всё уходит на clean-path —
  // ровно тот путь, где прежний -b устраивал шторм.
  mgr._reattachWorktree = () => null;
  const handle = mgr.ensureWorktree(repo, 'PROJECT:SVC');
  const dir = wtDir(root, 'PROJECT:SVC');
  assert.equal(handle.worktreeCwd, dir);
  // Ключевые инварианты фикса: worktree встал на TIP ветки (дельта сохранена), а не
  // сброшен на main HEAD; ветка НЕ пересоздана (тот же tip). Старый код (branch -D +
  // -b) сбросил бы worktree на mainHead и потерял бы delta.txt.
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), branchTip, 'clean-path: worktree на tip ветки, дельта цела');
  assert.equal(existsSync(join(dir, 'delta.txt')), true, 'невлитая дельта ветки сохранена в worktree');
  assert.equal(branchSha(repo, branch), branchTip, 'существующая ветка переиспользована, а не удалена/пересоздана');
  cleanup(repo, root);
});

test('stale-branch: _addWorktreeOnBranch создаёт свежую ветку от HEAD, когда её нет', () => {
  const repo = makeRepo();
  const root = newRoot();
  const mgr = new WorktreeManager({ root, log: silent });
  const mainHead = git(repo, ['rev-parse', 'HEAD']).trim();
  const branch = 'programmer/PROJECT/NEW';
  assert.equal(mgr._branchExists(repo, branch), false, 'ветки ещё нет');
  const dir = wtDir(root, 'PROJECT:NEW');
  mgr._addWorktreeOnBranch(repo, dir, branch);
  assert.equal(mgr._branchExists(repo, branch), true, 'ветка создана');
  assert.equal(git(dir, ['rev-parse', 'HEAD']).trim(), mainHead, 'свежая ветка растёт от HEAD main');
  cleanup(repo, root);
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
