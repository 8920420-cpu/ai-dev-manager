// Межпроцессный (cross-process) лок СТРУКТУРНЫХ git-операций одного репозитория.
//
// Зачем: programmer-runner и host-runner (Git Integrator) — РАЗНЫЕ хостовые процессы,
// но оба выполняют структурные git-команды на ОДНОМ репозитории:
//   • programmer-runner: `git worktree add/remove/prune`, `branch -D` (WorktreeManager);
//   • host-runner (GI): `git stash/cherry-pick/reset/commit` в том же repoRoot.
// Внутрипроцессные мьютексы (WorktreeManager.withRepoLock, mainLock) сериализуют
// операции ТОЛЬКО внутри своего процесса. Между процессами они не координируются, и
// `worktree prune` одного сносит полусозданную admin-запись `.git/worktrees/<id>`
// другого из-под ног → `git worktree add` падает
//   fatal: Unable to create '<dir>/.git/index.lock': No such file or directory
// (тот же отпечаток, что и внутрипроцессная гонка, но между демонами). Замер:
// ~50% провалов Programmer/GI (worktree_ensure_failed / dirty_worktree_conflict).
//
// Решение: файловый лок (эксклюзивное создание файла — атомарно и на NTFS, и на ext4)
// с ключом по каноническому пути репозитория. Оба демона берут ОДИН и тот же лок
// вокруг структурного участка. Критические секции короткие (worktree add/cherry-pick —
// секунды), поэтому lock держится недолго и параллелизм по РАЗНЫМ репозиториям цел.
//
// Восстановление после падения держателя:
//   • тот же хост + мёртвый pid (process.kill(pid,0) бросает) → украсть немедленно;
//   • иначе TTL-фолбэк: запись старше staleMs → украсть (страховка для чужого хоста /
//     переиспользованного pid). staleMs заведомо больше любой легитимной операции,
//     поэтому живой держатель не крадётся (проверка pid — основной сигнал).
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const LOCK_DIR = join(tmpdir(), 'ai-dev-worktree-locks');
const HOST = hostname();

// Канонический ключ репозитория: абсолютный путь, прямые слэши, нижний регистр
// (Windows регистронезависим; F:\git\PS и F:/git/ps — один репозиторий).
export function repoLockKey(repoCwd) {
  return resolve(String(repoCwd ?? '.')).replace(/\\/g, '/').toLowerCase();
}

export function lockPathFor(repoCwd) {
  const h = createHash('sha1').update(repoLockKey(repoCwd)).digest('hex').slice(0, 16);
  return join(LOCK_DIR, `repo-${h}.lock`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Прочитать держателя лока. Битый/пустой файл трактуем как «неизвестен» → later
// TTL-фолбэк его уберёт.
function readHolder(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

/**
 * Взять межпроцессный лок репозитория на время fn().
 * @param {string} repoCwd  корень репозитория (любая форма пути — канонизуется)
 * @param {() => (Promise<T>|T)} fn  критическая секция
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=180000]  максимум ожидания лока (иначе throw)
 * @param {number} [opts.staleMs=120000]    TTL: запись старше — считается протухшей
 * @param {number} [opts.pollMs=50]         базовый интервал опроса (с джиттером)
 * @param {{info?:Function,warn?:Function}} [opts.log]
 * @returns {Promise<T>}
 */
export async function withRepoWorktreeLock(repoCwd, fn, opts = {}) {
  const { timeoutMs = 180000, staleMs = 120000, pollMs = 50, log = null } = opts;
  const lockPath = lockPathFor(repoCwd);
  mkdirSync(LOCK_DIR, { recursive: true });
  const payload = JSON.stringify({ pid: process.pid, host: HOST, ts: Date.now(), repo: repoLockKey(repoCwd) });
  const deadline = Date.now() + timeoutMs;

  // ---- захват ----
  let acquired = false;
  while (!acquired) {
    try {
      const fd = openSync(lockPath, 'wx'); // атомарно: EEXIST, если файл уже есть
      writeSync(fd, payload);
      closeSync(fd);
      acquired = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const holder = readHolder(lockPath);
      const sameHostDead = holder && holder.host === HOST && !pidAlive(holder.pid);
      const ttlStale = !holder || (Date.now() - Number(holder.ts || 0)) > staleMs;
      if (sameHostDead || ttlStale) {
        // Держатель мёртв/протух — снимаем и пробуем снова (гонка краж разрешится
        // тем, что openSync('wx') отдаст файл ровно одному).
        try { unlinkSync(lockPath); } catch { /* уже снят другим — ок */ }
        log?.warn?.('repo worktree lock: снят протухший держатель', { repo: repoLockKey(repoCwd), holder });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`repo_worktree_lock_timeout: ${repoLockKey(repoCwd)} держит pid=${holder?.pid} host=${holder?.host}`);
      }
      await sleep(pollMs + Math.floor(Math.random() * pollMs));
    }
  }

  // ---- критическая секция ----
  try {
    return await fn();
  } finally {
    // Снимаем ТОЛЬКО свой лок (на случай, если нас уже украли по TTL и файл теперь чужой).
    try {
      const holder = readHolder(lockPath);
      if (holder && holder.pid === process.pid && holder.host === HOST) unlinkSync(lockPath);
    } catch { /* best-effort */ }
  }
}
