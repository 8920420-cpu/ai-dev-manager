// ORCH-BOOT-CLAIM-GRACE-001 — короткое окно «тишины» по claim'ам после обрыва
// соединения с БД, чтобы во время шторма не плодить осиротевшие RUNNING-прогоны.
//
// Контекст. advanceAutomatedTasks клеймит задачу в одной транзакции, зовёт модель
// ВНЕ транзакции и финализирует в другой. Если соединение с БД рвётся между
// claim'ом и финализацией (флапающий Patroni/pgbouncer — см. заметки
// patroni-single-node-flapping, boot-storm-wedges-running-runs), agent_run
// остаётся в RUNNING и держит слот роли до RUNNER_ROLE_TIMEOUT_MS (30 мин). При
// шторме это повторяется каждый тик и заклинивает очередь сиротами.
//
// Фикс в двух частях:
//   • реактивная — claim/process поймал обрыв соединения → фиксируем момент сбоя
//     (noteDbConnectionFailure);
//   • проактивная — пока с последнего сбоя не прошло GRACE_MS, ближайшие тики не
//     запускают НОВЫХ claim'ов (claimGraceActive=true). Предшаги тика
//     (реконсиляция часов, реап сирот, fork/join) продолжают работать — именно они
//     расчищают уже осиротевшие прогоны, пока claim'ы придержаны.
//
// Часы — монотонные (process.hrtime через monoNowMs), а НЕ настенные: настенные
// часы Docker-VM прыгают (CLOCK-GUARD-001), что исказило бы длину окна.

import { monoNowMs } from './clockGuard.js';

function envInt(name, def) {
  const n = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}

// Длина окна тишины после обрыва соединения. Runner-интервал ~3 c, поэтому 15 c —
// это ~5 придержанных тиков: хватает Patroni/pgbouncer переизбрать лидера и
// стабилизироваться, но throughput простаивает недолго. 0 — выключить гейт.
const GRACE_MS = Math.max(0, envInt('RUNNER_BOOT_CLAIM_GRACE_MS', 15_000));

// Класс connection-ошибок Postgres (SQLSTATE class 08) + транзиентные сбои
// доступности при failover: 57P0x (admin/crash shutdown, cannot connect now) и
// 25006 (попали на read-only реплику). Все они означают «БД сейчас нестабильна,
// claim рискует осиротеть».
const CONNECTION_SQLSTATES = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '57P01', '57P02', '57P03', '25006',
]);

// errno-коды сокета, которые node-pg/libpq кладут в error.code как строку.
const CONNECTION_ERRNO_RE = /^(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH)$/i;

// Текст ошибок без машинного кода (node-pg рвёт сокет с человекочитаемым message).
const CONNECTION_MESSAGE_RE =
  /(ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|connection terminated|connection error|terminating connection|server closed the connection|the database system is (starting up|shutting down|in recovery)|socket hang up|read[- ]only)/i;

// Последний зафиксированный обрыв (монотонные мс). null — штормов ещё не было.
let lastFailureMs = null;

// Похоже ли исключение на обрыв/нестабильность соединения с БД (а не на бизнес-
// ошибку запроса). Только такие сбои продлевают окно тишины.
export function isDbConnectionError(error) {
  if (!error) return false;
  const code = error.code != null ? String(error.code) : '';
  if (code && (CONNECTION_SQLSTATES.has(code) || CONNECTION_ERRNO_RE.test(code))) return true;
  const msg = error.message != null ? String(error.message) : '';
  return CONNECTION_MESSAGE_RE.test(msg);
}

// Зафиксировать момент обрыва соединения. now — монотонные мс (по умолчанию
// текущие); из advanceAutomatedTasks приходит opts.now (undefined в проде → дефолт,
// заданное число — в тестах). Берём максимум: параллельные воркеры одного тика
// могут записать слегка разные метки, окно отсчитываем от самого позднего сбоя.
export function noteDbConnectionFailure(now = monoNowMs()) {
  const t = Number.isFinite(now) ? now : monoNowMs();
  lastFailureMs = lastFailureMs == null ? t : Math.max(lastFailureMs, t);
  return lastFailureMs;
}

// Активно ли сейчас окно тишины (нужно ли придержать новые claim'ы этого тика).
export function claimGraceActive(now = monoNowMs(), graceMs = GRACE_MS) {
  if (lastFailureMs == null || graceMs <= 0) return false;
  const t = Number.isFinite(now) ? now : monoNowMs();
  return t - lastFailureMs < graceMs;
}

// --- Тестовые помощники ------------------------------------------------------
export function __resetBootClaimGuard() {
  lastFailureMs = null;
}
export function __getLastFailureMsForTest() {
  return lastFailureMs;
}
