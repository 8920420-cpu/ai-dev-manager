// Изоляция параллельных задач PROGRAMMER через git worktree — ПО МИКРОСЕРВИСАМ.
//
// Разработка идёт с разделением по микросервисам (поле task.service: IAM, PRINT,
// PRICING, GETWAY, …). Задачи ОДНОГО микросервиса трогают одни и те же файлы — их
// надо сериализовать; задачи РАЗНЫХ микросервисов трогают разные поддеревья —
// их можно вести параллельно. Поэтому изоляция ключуется по микросервису:
//
//   • один персистентный worktree на микросервис (ветка programmer/<project>/<service>);
//   • задачи одного сервиса сериализуются на его worktree (mutex по ключу сервиса);
//   • разные сервисы работают в своих worktree параллельно;
//   • каждая задача коммитит в ветку сервиса и применяет в main ТОЛЬКО свою дельту
//     (diff последнего коммита), а шаг «применить в main» сериализуется глобально.
//
// Дорогой шаг (LLM) идёт параллельно по сервисам, дешёвый «слить в main» — по одному.
// Это «грязный край» (реальные git-эффекты): юнит-тестами покрыт инъектируемый
// ProgrammerRunner, а сам менеджер — git-смоуком.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

// Глобальная сериализация шага «применить дельту в main»: два сервиса не должны
// накатывать патч в основное дерево одновременно (гонка индекса/рабочей копии).
let mainLock = Promise.resolve();
function withMainLock(fn) {
  const run = mainLock.then(() => fn());
  mainLock = run.then(() => {}, () => {}); // одно упавшее звено не рвёт цепочку
  return run;
}

const sanitize = (s) => String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_') || '_';

export class WorktreeManager {
  /**
   * @param {Object} [cfg]
   * @param {string} [cfg.root]  корень для worktree сервисов (по умолчанию tmp)
   * @param {Console} [cfg.log]
   */
  constructor({ root, log = console } = {}) {
    this.root = root || process.env.PROGRAMMER_WORKTREE_ROOT || join(tmpdir(), 'programmer-worktrees');
    this.log = log;
    this.services = new Map(); // serviceKey -> { worktreeCwd, branch }
    this.locks = new Map();    // serviceKey -> Promise (mutex по сервису)
  }

  // Сериализация задач одного микросервиса: следующая ждёт предыдущую.
  withServiceLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn());
    this.locks.set(key, run.then(() => {}, () => {}));
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
    // Подчистим возможный осиротевший worktree/ветку от прошлого запуска.
    try { git(repoCwd, ['worktree', 'remove', '--force', dir]); } catch { /* нет — ок */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* нет — ок */ }
    try { git(repoCwd, ['branch', '-D', branch]); } catch { /* нет — ок */ }
    try { git(repoCwd, ['worktree', 'prune']); } catch { /* не критично */ }
    mkdirSync(this.root, { recursive: true });
    git(repoCwd, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
    const handle = { worktreeCwd: dir, branch };
    this.services.set(serviceKey, handle);
    return handle;
  }

  /**
   * Выполнить задачу сервиса в его worktree (сериализованно), затем применить
   * дельту в main. agentFn(worktreeCwd) → { ok, error?, result? }.
   * @returns {Promise<{ok:boolean, error?:string, changedFiles:string[], result?:object}>}
   */
  runForService(repoCwd, serviceKey, agentFn) {
    return this.withServiceLock(serviceKey, async () => {
      let handle;
      try {
        handle = this.ensureWorktree(repoCwd, serviceKey);
      } catch (e) {
        this.log.warn?.('worktree ensure failed', { serviceKey, error: e.message });
        return { ok: false, error: `worktree_ensure_failed: ${e.message}`, changedFiles: [] };
      }
      const agentOut = await agentFn(handle.worktreeCwd);
      if (!agentOut || agentOut.ok !== true) {
        return { ok: false, error: agentOut?.error || 'agent_failed', changedFiles: [] };
      }
      return this._commitAndIntegrate(repoCwd, handle, agentOut);
    });
  }

  // Зафиксировать правки задачи коммитом в ветке сервиса, вычислить дельту
  // (последний коммит) и применить её в main под глобальным локом.
  async _commitAndIntegrate(repoCwd, handle, agentOut) {
    const wt = handle.worktreeCwd;
    git(wt, ['add', '-A']);
    const staged = git(wt, ['diff', '--cached', '--name-only']).split('\n').map((s) => s.trim()).filter(Boolean);
    if (!staged.length) {
      // Агент ничего не изменил — это валидный исход (нечего сливать).
      return { ok: true, changedFiles: [], result: agentOut.result };
    }
    // Коммитим дельту в ветке сервиса (идентичность фиксируем флагами -c, чтобы
    // не зависеть от глобального git-config на хосте).
    git(wt, [
      '-c', 'user.name=programmer-runner', '-c', 'user.email=programmer-runner@local',
      'commit', '--quiet', '--no-verify', '-m', 'programmer: task delta',
    ]);
    const patch = git(wt, ['diff', '--binary', 'HEAD~1', 'HEAD']);
    const changedFiles = git(wt, ['diff', '--name-only', 'HEAD~1', 'HEAD'])
      .split('\n').map((s) => s.trim()).filter(Boolean);

    return withMainLock(() => {
      try {
        execFileSync('git', ['-C', repoCwd, 'apply', '--binary', '--whitespace=nowarn', '-'], {
          input: patch, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        });
        return { ok: true, changedFiles, result: agentOut.result };
      } catch (e) {
        this.log.warn?.('integrate conflict, requeue', { branch: handle.branch, error: e.message });
        return { ok: false, conflict: true, error: `integrate_conflict: ${e.message}`, changedFiles };
      }
    });
  }

  // Снести все worktree сервисов (на остановке процесса). Идемпотентно.
  cleanupAll(repoByService = new Map()) {
    for (const [serviceKey, handle] of this.services) {
      const repoCwd = repoByService.get(serviceKey);
      if (!repoCwd) continue;
      try { git(repoCwd, ['worktree', 'remove', '--force', handle.worktreeCwd]); } catch { /* ок */ }
      try { git(repoCwd, ['branch', '-D', handle.branch]); } catch { /* ок */ }
    }
    this.services.clear();
  }
}
