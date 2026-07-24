// Изоляция параллельных задач PROGRAMMER через git worktree — ПО МИКРОСЕРВИСАМ.
//
// Разработка идёт с разделением по микросервисам (поле task.service: IAM, PRINT,
// PRICING, GETWAY, …). Задачи ОДНОГО микросервиса трогают одни и те же файлы — их
// надо сериализовать; задачи РАЗНЫХ микросервисов трогают разные поддеревья —
// их можно вести параллельно. Поэтому изоляция ключуется по микросервису:
//
//   • один персистентный worktree на микросервис (ветка programmer/<project>/<service>);
//   • перед каждой задачей ветка освежается от main, если вся её дельта уже
//     влита (иначе база протухает и дельты перестают ложиться на main);
//   • задачи одного сервиса сериализуются на его worktree (mutex по ключу сервиса);
//   • разные сервисы работают в своих worktree параллельно;
//   • каждая задача коммитит СВОЮ дельту в ветку сервиса и БОЛЬШЕ НИЧЕГО не пишет
//     в общее рабочее дерево репозитория (WORKTREE-ISOLATE-DELIVERY-001, см. ниже).
//
// WORKTREE-ISOLATE-DELIVERY-001: раньше дельта, помимо коммита в ветку, ещё и
// НАКАТЫВАЛАСЬ незакоммиченной в общее дерево (`git apply` в repoCwd) — чтобы
// следующая стадия TESTING (Pipeline Service) видела новый код в общем дереве. Но
// если задача не доходила до Git Integrator (BLOCKED / release-петля), этот
// незакоммиченный накат оставался в общем дереве, копился по многим задачам и
// сервисам, перемешивался и терялся при reset/рестарте (рецидив «код Программиста
// в дереве PS не закоммичен → работа копится незакоммиченной»). Теперь Программист
// НИКОГДА не трогает общее дерево: дельта живёт только коммитом в изолированной
// ветке сервиса; TESTING гоняется на изолированном checkout этой ветки
// (host-runner runPipelineAction), а в main её вливает ЕДИНСТВЕННЫЙ писатель —
// Git Integrator (cherry-pick ветки). Общее дерево от Программиста всегда чистое.
//
// Дорогой шаг (LLM) идёт параллельно по сервисам. Это «грязный край» (реальные
// git-эффекты): юнит-тестами покрыт инъектируемый ProgrammerRunner, а сам
// менеджер — git-смоуком.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withRepoWorktreeLock } from '../../shared/repoWorktreeLock.js';

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

const sanitize = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_') || '_';

// PROGRAMMER-DELTA-DENYLIST-001: артефакты сборки/генерации не должны попадать в
// дельту программиста. Они регенерируются из исходников, побайтово пляшут между
// прогонами и дают ЛОЖНЫЙ integrate_conflict в main (частый случай — *.tsbuildinfo,
// dist/ при неполном .gitignore ЦЕЛЕВОГО репозитория: `git add -A` уважает .gitignore,
// но целевые репо нередко забывают их исключить). Это страховочный слой ПОВЕРХ
// .gitignore. Расширяется через PROGRAMMER_DELTA_DENY_GLOBS (список через запятую;
// `*.ext` — по расширению, имя без `*` — как сегмент пути: `dist` ловит `dist/a`,
// `x/dist/b`). Осознанный риск: если целевой репо КОММИТИТ такой путь как исходник,
// правка в нём не доедет — сузьте deny-list через env. Выброшенные пути логируются.
const DEFAULT_DENY_GLOBS = [
  '*.tsbuildinfo',
  'node_modules', 'dist',
  '.next', '.nuxt', '.svelte-kit', '.turbo',
  '__pycache__', '*.pyc',
  // PROGRAMMER-DELTA-DENYLIST-MEMORY-001: артефакты codebase-memory и авто-доки
  // регенерируются вотчдогом/analyze НЕЗАВИСИМО от задач и постоянно пляшут в
  // рабочем дереве. `git add -A` в worktree затягивал `.claude/rules/changelog.md`
  // (и др.) в дельту → Git Integrator честно падал на dirty_worktree_conflict в
  // общем дереве (файл там свой, мисматч с tip). Память ведёт codebase-memory, а
  // не дельты ролей — исключаем её из коммита-дельты, как и артефакты сборки.
  // Сегментный матч: `.claude` ловит `.claude/rules/*`; имена-файлы ловятся как
  // сегмент пути (`docs/API_MAP.md`, `orchestrator-service/backend/CLAUDE.md`).
  '.claude', 'CLAUDE.md', 'CONVENTIONS.md', 'API_MAP.md',
];

function parseDenyGlobs(raw) {
  const list = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : DEFAULT_DENY_GLOBS;
}

// WORKTREE-REBASE-STALE-001: перебазировать ветку сервиса с НЕВЛИТОЙ дельтой на
// свежий main, когда её база протухла (см. _syncWithMain). Аварийный клапан —
// PROGRAMMER_SYNC_REBASE=0/false/off откатывает на прежнее поведение (пропуск синка).
const SYNC_REBASE_ENABLED = !/^(0|false|off)$/i.test(String(process.env.PROGRAMMER_SYNC_REBASE ?? '').trim());

// Совпадает ли путь дельты с deny-glob. path — от git (уже forward-slash, но на
// всякий случай нормализуем). `*.ext` → по суффиксу; имя без `*` → как ТОЧНЫЙ
// сегмент пути (не подстрока: `dist` не заденет `distributor.js`).
function matchesDeny(path, globs) {
  const p = String(path).replace(/\\/g, '/');
  const segs = p.split('/');
  for (const g of globs) {
    if (g.startsWith('*.')) {
      if (p.endsWith(g.slice(1))) return true;
    } else if (segs.includes(g)) {
      return true;
    }
  }
  return false;
}

export class WorktreeManager {
  /**
   * @param {Object} [cfg]
   * @param {string} [cfg.root]  корень для worktree сервисов (по умолчанию tmp)
   * @param {Console} [cfg.log]
   */
  constructor({ root, log = console, denyGlobs } = {}) {
    this.root = root || process.env.PROGRAMMER_WORKTREE_ROOT || join(tmpdir(), 'programmer-worktrees');
    this.log = log;
    this.services = new Map(); // serviceKey -> { worktreeCwd, branch }
    this.locks = new Map();    // serviceKey -> Promise (mutex по сервису)
    this.repoLocks = new Map();// repoCwd -> Promise (mutex по репозиторию)
    // PROGRAMMER-DELTA-DENYLIST-001: артефакты, исключаемые из дельты (см. выше).
    this.denyGlobs = denyGlobs || parseDenyGlobs(process.env.PROGRAMMER_DELTA_DENY_GLOBS);
  }

  // Сериализация задач одного микросервиса: следующая ждёт предыдущую.
  withServiceLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    this.locks.set(key, run.then(() => {}, () => {}));
    return run;
  }

  // Сериализация СТРУКТУРНЫХ git-worktree операций одного репозитория. withServiceLock
  // разводит только задачи ОДНОГО сервиса, но ensureWorktree дёргает глобальные для
  // всего репо команды (`worktree prune`, `branch -D`, `worktree add`, `worktree
  // remove`). При concurrency>1 два РАЗНЫХ сервиса входят в ensureWorktree
  // одновременно, и `worktree prune` одного сносит полусозданную admin-запись
  // (`.git/worktrees/<id>`) другого из-под ног → `worktree add` падает
  // «Unable to create '<dir>/.git/index.lock': No such file or directory» (ENOENT).
  // Инцидент 09.07: рестарт раннера опустошил кэш worktree → массовое одновременное
  // пересоздание worktree разных сервисов → шторм worktree_ensure_failed увёл 8 задач
  // в BLOCKED (programmer_release_loop). Лок держится только на короткий шаг
  // ensureWorktree; дорогой шаг агента и слияние в main остаются параллельными.
  // WORKTREE-CROSSPROC-LOCK-001: два уровня. (1) Внутрипроцессный мьютекс по repoCwd —
  // разводит структурные worktree-операции РАЗНЫХ сервисов в ЭТОМ процессе. (2) Межпроцессный
  // файловый лок (shared/repoWorktreeLock) — координирует с host-runner (Git Integrator),
  // который делает cherry-pick/stash/reset на ТОМ ЖЕ репо: без него `worktree prune` GI
  // сносил admin-запись полусозданного worktree программиста → worktree_ensure_failed.
  withRepoLock(repoCwd, fn) {
    const key = String(repoCwd);
    const prev = this.repoLocks.get(key) || Promise.resolve();
    const run = prev.then(() => withRepoWorktreeLock(repoCwd, fn, { log: this.log }));
    this.repoLocks.set(key, run.then(() => {}, () => {}));
    return run;
  }

  // Гарантировать наличие worktree сервиса. Переиспользуем существующий (задачи
  // сервиса накапливают изменения друг друга), иначе создаём от текущего HEAD.
  ensureWorktree(repoCwd, serviceKey) {
    // Переиспользуем worktree этого сервиса в рамках процесса: задачи одного
    // сервиса накапливают изменения друг друга. Достаточно записи в Map +
    // существования каталога — этого процесса worktree всегда «свой».
    const cached = this.services.get(serviceKey);
    if (cached && existsSync(cached.worktreeCwd)) return cached;
    const dir = join(this.root, sanitize(serviceKey));
    const branch = `programmer/${serviceKey.split(':').map(sanitize).join('/')}`;
    mkdirSync(this.root, { recursive: true });
    // WORKTREE-REUSE-001: ветка сервиса может нести дельты, сданные, но ещё НЕ
    // влитые GI в main. Пересоздание от HEAD (branch -D) их ТЕРЯЛО: содержимое
    // оставалось незакоммиченной грязью в основном дереве, а ветка о нём забывала —
    // побайтовые сверки GI (санитайзер дубля) и _syncWithMain расходились, и
    // конвейер сервиса клинило (инцидент 09.07: рестарт раннера вотчдогом свежести
    // выбросил коммит дельты, GI встал на dirty_worktree_conflict). Поэтому после
    // рестарта процесса прицепляемся к существующей ветке, а не зачищаем её.
    const reused = this._reattachWorktree(repoCwd, dir, branch);
    if (reused) {
      this.services.set(serviceKey, reused);
      return reused;
    }
    // Прицепиться не удалось (сломанное/racy состояние worktree): зачищаем ОБЛОМКИ
    // (каталог + мёртвую admin-запись), но ВЕТКУ НЕ трогаем.
    // WORKTREE-ENSURE-STALE-BRANCH-001: прежде здесь был `branch -D` + безусловный
    // `worktree add -b`. Он (а) ТЕРЯЛ невлитую дельту ветки (branch -D сносил её
    // коммиты — против WORKTREE-REUSE-001) и (б) если ветку удалить не удавалось
    // (вычекана в другом worktree / удаление отклонено), падал `worktree add -b`
    // «branch already exists», а на racy-обломках — «index.lock: No such file or
    // directory», уводя задачу в шторм worktree_ensure_failed → programmer_release_loop
    // (инцидент 24.07: CRM/Chat_Service после ручного перезапуска стухшей ветки 23.07).
    // Теперь существующую ветку ПЕРЕИСПОЛЬЗУЕМ (add без -b), и только если её нет —
    // создаём свежую от HEAD (_addWorktreeOnBranch).
    try { git(repoCwd, ['worktree', 'remove', '--force', dir]); } catch { /* нет — ок */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* нет — ок */ }
    try { git(repoCwd, ['worktree', 'prune']); } catch { /* не критично */ }
    this._addWorktreeOnBranch(repoCwd, dir, branch);
    const handle = { worktreeCwd: dir, branch };
    this.services.set(serviceKey, handle);
    return handle;
  }

  // Существует ли локальная ветка (без throw).
  _branchExists(repoCwd, branch) {
    try {
      git(repoCwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  // Поднять worktree каталога dir на ветке branch. Ветка есть → ПЕРЕИСПОЛЬЗУЕМ её
  // (add без -b: невлитая дельта сохраняется, WORKTREE-REUSE-001); ветки нет →
  // создаём свежую от HEAD (-b). НИКОГДА не пересоздаём существующую ветку через -b:
  // это падало «branch already exists» и роняло задачу в шторм worktree_ensure_failed
  // → programmer_release_loop (WORKTREE-ENSURE-STALE-BRANCH-001).
  _addWorktreeOnBranch(repoCwd, dir, branch) {
    if (this._branchExists(repoCwd, branch)) {
      git(repoCwd, ['worktree', 'add', '--quiet', dir, branch]);
    } else {
      git(repoCwd, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
    }
  }

  // Прицепиться к существующим worktree/ветке сервиса после рестарта процесса.
  // Возвращает handle либо null (ветки нет / состояние не поддаётся переиспользованию).
  _reattachWorktree(repoCwd, dir, branch) {
    if (!this._branchExists(repoCwd, branch)) return null; // ветки нет — штатное чистое создание
    try {
      let dirOnBranch = false;
      if (existsSync(dir)) {
        try { dirOnBranch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === branch; } catch { /* не git-каталог */ }
      }
      if (dirOnBranch) {
        // Каталог уже смотрит в нужную ветку. Недокоммиченные правки в нём — след
        // прогона, убитого рестартом; его задача переигрывается заново, поэтому
        // сбрасываем только НЕЗАКОММИЧЕННОЕ (коммиты-дельты ветки целы).
        git(dir, ['reset', '--hard']);
        git(dir, ['clean', '-fd']);
      } else {
        // Каталога нет (tmp почищен) или он смотрит не туда — поднимаем worktree
        // НА существующей ветке (без -b), предварительно сняв мёртвую регистрацию.
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* нет — ок */ }
        try { git(repoCwd, ['worktree', 'prune']); } catch { /* не критично */ }
        git(repoCwd, ['worktree', 'add', '--quiet', dir, branch]);
      }
      this.log.info?.('worktree переиспользован после рестарта (ветка сохранена)', { branch });
      return { worktreeCwd: dir, branch };
    } catch (e) {
      this.log.warn?.('worktree reattach не удался — пересоздаю с нуля', { branch, error: e.message });
      return null;
    }
  }

  // Освежить ветку сервиса от текущего main, когда это безопасно. Ветка живёт
  // столько же, сколько процесс раннера, а main тем временем уезжает вперёд
  // (GI вливает дельты, ручные merge). Без освежения база ветки протухает:
  // агент правит устаревшее содержимое, и дельта задачи перестаёт ложиться на
  // main — integrate_conflict «содержимое расходится» (инцидент 09.07, CHAT:
  // main получил auth-гейт виджета, ветка его не видела).
  // Сбрасываем ветку на HEAD main ТОЛЬКО когда сброс ничего не теряет — вся
  // дельта ветки уже в main: каждый её коммит эквивалентно влит (git cherry,
  // patch-id) либо содержимое затронутых файлов побайтово совпадает с HEAD.
  // Неинтегрированную дельту (окно «сдано, GI ещё не вливал») не трогаем.
  _syncWithMain(repoCwd, handle) {
    const wt = handle.worktreeCwd;
    const mainHead = git(repoCwd, ['rev-parse', 'HEAD']).trim();
    const tip = git(wt, ['rev-parse', 'HEAD']).trim();
    if (tip === mainHead) return; // уже синхронны
    const mergeBase = git(repoCwd, ['merge-base', mainHead, tip]).trim();
    if (mergeBase === mainHead) return; // main не двигался — ветка просто несёт свежую дельту
    if (mergeBase !== tip) {
      // Ветка несёт коммиты после развилки — сброс безопасен, только если все
      // они уже в main (git cherry: '+' = патча в main нет)…
      const pending = git(repoCwd, ['cherry', mainHead, tip])
        .split('\n').filter((line) => line.startsWith('+'));
      if (pending.length) {
        // …либо содержимое всех затронутых веткой файлов побайтово совпадает с
        // HEAD main (влито с иной историей). git diff --quiet кидает при отличиях.
        const changed = git(repoCwd, ['diff', '--name-only', `${mergeBase}..${tip}`])
          .split('\n').map((s) => s.trim()).filter(Boolean);
        try {
          if (changed.length) git(repoCwd, ['diff', '--quiet', tip, mainHead, '--', ...changed]);
        } catch {
          // Неинтегрированная дельта на ПРОТУХШЕЙ базе: main ушёл вперёд, а
          // содержимое затронутых веткой файлов расходится с ним. Раньше синк
          // ПРОПУСКАЛСЯ — агент правил устаревшее содержимое, и дельта не ложилась
          // на main: cherry_pick_failed / stale_branch_reverts_main (инцидент
          // 23.07 — ветка CHAT с базой 09.07, −304 коммита от main).
          // WORKTREE-REBASE-STALE-001: переносим дельту на свежий main через rebase.
          // Коммиты сохраняются (reset их бы потерял), их SHA переписываются — но
          // GI ключуется по ИМЕНИ ветки и диапазону merge-base..tip, а не по
          // стабильному SHA, поэтому доставка не ломается. Любой сбой rebase
          // (конфликт по общим строкам) → rebase --abort и работаем на текущей базе
          // (прежнее поведение, строго не хуже). Клапан: PROGRAMMER_SYNC_REBASE=0.
          if (!SYNC_REBASE_ENABLED) {
            this.log.info?.('worktree sync skipped: неинтегрированная дельта (rebase выключен)',
              { branch: handle.branch, pending: pending.length });
            return;
          }
          try {
            git(wt, [
              '-c', 'user.name=programmer-runner', '-c', 'user.email=programmer-runner@local',
              'rebase', mainHead,
            ]);
            this.log.info?.('worktree branch перебазирована на свежий main (дельта сохранена)',
              { branch: handle.branch, head: mainHead.slice(0, 12), pending: pending.length });
          } catch (e) {
            // Конфликт (или сбой) rebase: снимаем незавершённое состояние и остаёмся
            // на текущей базе — GI честно заблокирует при реальном конфликте, как и до фикса.
            try { git(wt, ['rebase', '--abort']); } catch { /* нет активного rebase — ок */ }
            this.log.warn?.('worktree rebase на main не удался — работаем на текущей базе',
              { branch: handle.branch, error: e.message });
          }
          return;
        }
      }
    }
    git(wt, ['reset', '--hard', mainHead]);
    this.log.info?.('worktree branch синхронизирована с main',
      { branch: handle.branch, head: mainHead.slice(0, 12) });
  }

  /**
   * Выполнить задачу сервиса в его worktree (сериализованно) и закоммитить дельту
   * в ветку сервиса. Общее дерево репозитория НЕ трогается (WORKTREE-ISOLATE-
   * DELIVERY-001). agentFn(worktreeCwd) → { ok, error?, result? }.
   * branch — ветка worktree сервиса (`programmer/<project>/<service>`), commit —
   * SHA коммита дельты 'programmer: task delta' (null, если дельта пустая): по ним
   * TESTING гоняется на checkout ветки, а GIT_INTEGRATION вливает ветку в main.
   * @returns {Promise<{ok:boolean, error?:string, changedFiles:string[], result?:object, branch:string, commit:(string|null)}>}
   */
  runForService(repoCwd, serviceKey, agentFn) {
    return this.withServiceLock(serviceKey, async () => {
      let handle;
      try {
        // Структурные worktree-операции сериализуем по репозиторию (не только по
        // сервису): prune/branch -D/worktree add глобальны для .git и гонятся между
        // разными сервисами при concurrency>1 (см. withRepoLock).
        handle = await this.withRepoLock(repoCwd, () => this.ensureWorktree(repoCwd, serviceKey));
      } catch (e) {
        this.log.warn?.('worktree ensure failed', { serviceKey, error: e.message });
        return { ok: false, error: `worktree_ensure_failed: ${e.message}`, changedFiles: [] };
      }
      try {
        this._syncWithMain(repoCwd, handle);
      } catch (e) {
        // Сбой синхронизации не валит задачу — работаем на текущей базе ветки.
        this.log.warn?.('worktree sync failed, работаем на текущей базе', { serviceKey, error: e.message });
      }
      const agentOut = await agentFn(handle.worktreeCwd);
      if (!agentOut || agentOut.ok !== true) {
        // Прокидываем маркеры исхода исполнителя (например, limitHit при упоре в
        // лимит ходов) — иначе оркестратор не отличит это от обычного провала.
        // Ветку сервиса отдаём и здесь (commit=null): контракт результата един.
        return {
          ok: false,
          error: agentOut?.error || 'agent_failed',
          changedFiles: [],
          limitHit: agentOut?.limitHit,
          // PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: маркер кросс-сервисного блокера
          // должен дойти до ProgrammerRunner → оркестратора (иначе теряется здесь).
          blockerKind: agentOut?.blockerKind,
          meta: agentOut?.meta,
          branch: handle.branch,
          commit: null,
        };
      }
      return this._commitDelta(handle, agentOut);
    });
  }

  // Зафиксировать правки задачи коммитом в ветке сервиса и вернуть дельту для
  // доставки. Общее дерево репозитория НЕ трогаем: TESTING гоняется на checkout
  // ветки, а в main дельту вливает Git Integrator (WORKTREE-ISOLATE-DELIVERY-001).
  _commitDelta(handle, agentOut) {
    const wt = handle.worktreeCwd;
    git(wt, ['add', '-A']);
    let staged = git(wt, ['diff', '--cached', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
    // PROGRAMMER-DELTA-DENYLIST-001: убрать из индекса артефакты сборки/генерации,
    // чтобы они не попали в коммит-дельту и не порождали ложный конфликт при вливании.
    const denied = staged.filter((f) => matchesDeny(f, this.denyGlobs));
    if (denied.length) {
      try {
        git(wt, ['reset', '--quiet', '--', ...denied]);
      } catch (e) {
        // Не смогли снять из индекса — не валим задачу, просто предупреждаем.
        this.log.warn?.('deny-list: не удалось снять артефакты из индекса', { branch: handle.branch, error: e.message });
      }
      staged = staged.filter((f) => !matchesDeny(f, this.denyGlobs));
      this.log.info?.('дельта: исключены артефакты сборки/генерации (deny-list)',
        { branch: handle.branch, dropped: denied });
    }
    if (!staged.length) {
      // Агент ничего не изменил — это валидный исход (нечего сливать). Ветку сервиса
      // всё равно отдаём (commit=null): по ней GIT_INTEGRATION отличит «пустую» сдачу
      // от сдачи с дельтой (и решит, провал это интеграции или штатный no-op).
      return { ok: true, changedFiles: [], result: agentOut.result, branch: handle.branch, commit: null };
    }
    // Коммитим дельту в ветке сервиса (идентичность фиксируем флагами -c, чтобы
    // не зависеть от глобального git-config на хосте).
    git(wt, [
      '-c', 'user.name=programmer-runner', '-c', 'user.email=programmer-runner@local',
      'commit', '--quiet', '--no-verify', '-m', 'programmer: task delta',
    ]);
    // SHA коммита дельты в ветке сервиса — по нему Pipeline Service поднимает
    // изолированный checkout для TESTING, а GIT_INTEGRATION вливает его в main.
    const commit = git(wt, ['rev-parse', 'HEAD']).trim();
    const changedFiles = git(wt, ['diff', '--name-only', 'HEAD~1', 'HEAD'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
    return { ok: true, changedFiles, result: agentOut.result, branch: handle.branch, commit };
  }

  // Снести worktree сервисов (на остановке процесса). Идемпотентно.
  //
  // WORKTREE-ISOLATE-DELIVERY-001: ветка сервиса — ЕДИНСТВЕННАЯ копия дельты
  // (в общее дерево мы больше ничего не накатываем), поэтому НЕВЛИТУЮ ветку удалять
  // НЕЛЬЗЯ — force `branch -D` на остановке терял бы сданную, но ещё не влитую GI
  // работу. Каталог worktree убираем всегда (переподнимется по ветке при рестарте,
  // см. _reattachWorktree), а ветку сносим ТОЛЬКО если она полностью влита в main
  // (`merge-base --is-ancestor <branch> HEAD`); иначе оставляем её жить до вливания.
  cleanupAll(repoByService = new Map()) {
    for (const [serviceKey, handle] of this.services) {
      const repoCwd = repoByService.get(serviceKey);
      if (!repoCwd) continue;
      try { git(repoCwd, ['worktree', 'remove', '--force', handle.worktreeCwd]); } catch { /* ок */ }
      let merged = false;
      try {
        git(repoCwd, ['merge-base', '--is-ancestor', handle.branch, 'HEAD']);
        merged = true; // exit 0 → все коммиты ветки уже в main
      } catch { merged = false; } // exit 1 → есть невлитые коммиты (или ветки нет)
      if (merged) {
        try { git(repoCwd, ['branch', '-D', handle.branch]); } catch { /* ок */ }
      } else {
        this.log.info?.('cleanup: ветка с невлитой дельтой сохранена (не удаляем)', { branch: handle.branch });
      }
    }
    this.services.clear();
  }
}
