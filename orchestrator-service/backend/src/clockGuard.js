// CLOCK-GUARD-001 — устойчивость таймаутов к скачкам настенных часов БД/Docker-VM.
//
// Проблема. resetStaleClaims/releaseStaleClaudeClaims считают возраст захвата как
// now() - started_at, где и now(), и started_at — настенные часы БД. В WSL2/
// Docker-VM эти часы периодически «прыгают» вперёд на десятки минут — часы (диск/
// таймеры VM, см. заметку patroni-single-node-flapping). Сразу после скачка все
// прогоны «в полёте» одномоментно выглядят старше таймаута и гасятся пачкой
// ложных TIMEOUT, хотя реальный ИИ-вызов ещё идёт.
//
// Решение. На каждом цикле резалки сравниваем прирост часов БД с приростом
// МОНОТОННЫХ часов процесса (process.hrtime — не реагирует на коррекцию настенных
// часов NTP/гипервизором). Если БД ушла вперёд намного сильнее реально прошедшего
// времени — это скачок величиной Δ. Сдвигаем операционные метки «в полёте»
// (agent_runs.started_at у RUNNING и task_events AGENT_ASSIGNED у Programmer-задач
// в работе) вперёд на Δ, чтобы их видимый возраст остался прежним. Метки,
// записанные ПОСЛЕ скачка, уже в новом времени и не трогаются — поэтому реальные
// таймауты продолжают работать честно.
//
// Обратный скачок (часы БД ушли назад) безопасен — возраст лишь уменьшается,
// ложного таймаута не будет; просто переякориваемся, чтобы не принять
// последующее «навёрстывание» за прямой скачок.

// Скачком считаем расхождение БД-времени и монотонного больше порога (по умолчанию
// 60 c): отсекает обычный джиттер планировщика/задержку запроса.
const JUMP_THRESHOLD_MS = Number(process.env.RUNNER_CLOCK_JUMP_THRESHOLD_MS || 60_000);
// Резалка зовётся на каждый claim (часто); сверяем часы не чаще раза в N мс, иначе
// и измерять расхождение не на чем (нужен накопленный интервал).
const MIN_INTERVAL_MS = Number(process.env.RUNNER_CLOCK_RECONCILE_MS || 10_000);

// Состояние процесса: последняя точка синхронизации { монотонные мс, БД-мс }.
let baseline = null;
// Защита от переинициализации/гонки при параллельных воркерах в одном процессе.
let inProgress = false;

// Монотонные миллисекунды процесса. hrtime.bigint() — наносекунды; Number() до
// ~104 суток аптайма без потери мс-точности, чего более чем достаточно.
export function monoNowMs() {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * Чистое решение (без БД и побочек) — удобно тестировать.
 * @returns {{action:'anchor'|'compensate'|'reanchor'|'none', jumpMs:number}}
 *   anchor      — нет базлайна, только запоминаем точку;
 *   compensate  — прямой скачок: сдвинуть метки «в полёте» на jumpMs;
 *   reanchor    — обратный скачок: ничего не сдвигаем, только переякориваемся;
 *   none        — расхождение в пределах порога.
 */
export function decideClockSkew(base, monoMs, dbMs, thresholdMs = JUMP_THRESHOLD_MS) {
  if (!base) return { action: 'anchor', jumpMs: 0 };
  const realElapsed = monoMs - base.monoMs;
  const dbElapsed = dbMs - base.dbMs;
  const drift = dbElapsed - realElapsed;
  if (drift > thresholdMs) return { action: 'compensate', jumpMs: Math.round(drift) };
  if (drift < -thresholdMs) return { action: 'reanchor', jumpMs: Math.round(drift) };
  return { action: 'none', jumpMs: Math.round(drift) };
}

// Сдвиг операционных меток «в полёте» вперёд на jumpMs (компенсация прямого скачка).
async function shiftInFlight(c, jumpMs) {
  const ms = String(jumpMs);
  // Рассуждающие роли: возраст считается по agent_runs.started_at у RUNNING.
  await c.query(
    `UPDATE agent_runs
        SET started_at = started_at + ($1::bigint * interval '1 millisecond')
      WHERE status = 'RUNNING'`,
    [ms],
  );
  // Programmer-мост: возраст считается по последнему AGENT_ASSIGNED задачи в работе
  // (CODING под PROGRAMMER с назначенным агентом). Сдвигаем события только таких
  // задач — историю завершённых задач не трогаем.
  await c.query(
    `UPDATE task_events
        SET created_at = created_at + ($1::bigint * interval '1 millisecond')
      WHERE event_type = 'AGENT_ASSIGNED'
        AND task_id IN (
          SELECT t.id FROM tasks t JOIN roles r ON r.id = t.current_role_id
           WHERE r.code = 'PROGRAMMER'
             AND t.status = 'CODING'
             AND t.assigned_agent_id IS NOT NULL
        )`,
    [ms],
  );
}

/**
 * Сверить часы и при необходимости компенсировать скачок. Зовётся в начале
 * resetStaleClaims. БД-время читается из переданного клиента; монотонное берётся
 * из процесса (или из opts.monoMs — для детерминированных тестов).
 * @returns {Promise<{action:string, jumpMs:number}>}
 */
export async function reconcileClockSkew(c, { monoMs = monoNowMs(), log } = {}) {
  if (inProgress) return { action: 'skip', jumpMs: 0 };
  // Дебаунс: пока не накопился минимальный интервал, расхождение измерять не на чем.
  if (baseline && monoMs - baseline.monoMs < MIN_INTERVAL_MS) {
    return { action: 'debounced', jumpMs: 0 };
  }
  inProgress = true;
  try {
    const r = await c.query("SELECT EXTRACT(EPOCH FROM now()) * 1000 AS ms");
    const dbMs = Number(r?.rows?.[0]?.ms);
    // Часы БД не прочитались — не якоримся (иначе мусорная база), пропускаем цикл.
    if (!Number.isFinite(dbMs)) return { action: 'unavailable', jumpMs: 0 };
    const decision = decideClockSkew(baseline, monoMs, dbMs);
    if (decision.action === 'compensate') {
      await shiftInFlight(c, decision.jumpMs);
      if (log) {
        log(`[clock-guard] скачок часов БД +${Math.round(decision.jumpMs / 1000)} c — метки «в полёте» сдвинуты, ложный TIMEOUT предотвращён`);
      }
    }
    // Переякориваемся при любом исходе (anchor/compensate/reanchor/none): после
    // компенсации БД-время = dbMs, метки сдвинуты, новая база консистентна.
    baseline = { monoMs, dbMs };
    return decision;
  } finally {
    inProgress = false;
  }
}

// --- Тестовые помощники ------------------------------------------------------
export function __resetClockGuard() {
  baseline = null;
  inProgress = false;
}
export function __setBaselineForTest(b) {
  baseline = b;
}
