// PERFORMANCE-MONITOR-001 — НЕ-AI метрики и KPI оркестратора (read-only).
//
// Раздел «Монитор производительности»: всё считается чистыми SQL-агрегатами по
// tasks / task_events / agent_runs + in-memory телеметрия адаптивного лимитера.
// Никаких вызовов модели — только наблюдаемость: пропускная способность, очередь,
// повторная работа, нагрузка по ролям, длительности. Endpoint ничего не меняет.
import { withClient, clientConfig } from './db.js';
import { allStats as connectorBuckets } from './connectorLimiter.js';

const TERMINAL = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Чистый расчёт производных KPI из сырых агрегатов (тестируется без БД).
 * Вынесен отдельно, чтобы зафиксировать формулы (retryRate, доли) юнит-тестом.
 */
export function deriveKpi({ byStatus = {}, transitions = 0, reworkExtra = 0 } = {}) {
  let total = 0;
  for (const n of Object.values(byStatus)) total += Number(n) || 0;
  const done = byStatus.DONE ?? 0;
  const cancelled = byStatus.CANCELLED ?? 0;
  const failed = byStatus.FAILED ?? 0;
  const blocked = byStatus.BLOCKED ?? 0;
  const completed = done + cancelled;
  const terminal = done + cancelled + failed;
  const active = Math.max(0, total - terminal - blocked);
  // Доля повторной работы: лишние входы в уже посещённый статус / все переходы.
  const retryRate = transitions > 0 ? reworkExtra / transitions : 0;
  return {
    total,
    active,
    blocked,
    completed,
    failed,
    done,
    cancelled,
    transitions,
    reworkExtra,
    retryRate: Math.round(retryRate * 1000) / 1000,
  };
}

function countMap(rows, keyField = 'status', nField = 'n') {
  const out = {};
  for (const row of rows) out[row[keyField]] = Number(row[nField]) || 0;
  return out;
}

/**
 * GET /api/performance — сводка НЕ-AI метрик по всему оркестратору.
 * Опционально projectId — сузить задачи до одного проекта (метрики ролей и
 * лимитера остаются глобальными).
 */
export async function getPerformanceMetrics(s, { projectId } = {}) {
  return withClient(clientConfig(s), async (c) => {
    const generatedAt = new Date();

    const projectDbId = await resolveProjectId(c, projectId);
    const taskWhere = projectDbId ? 'WHERE project_id = $1' : '';
    const taskParams = projectDbId ? [projectDbId] : [];

    // 1) Задачи по статусам.
    const statusRows = await c.query(
      `SELECT status::text AS status, count(*)::int AS n FROM tasks ${taskWhere} GROUP BY status`,
      taskParams,
    );
    const byStatus = countMap(statusRows.rows);

    // 2) Очередь: ждут захвата исполнителем.
    const queueRows = await c.query(
      `SELECT
         count(*) FILTER (WHERE status = 'BACKLOG')::int AS backlog,
         count(*) FILTER (WHERE status = 'CODING' AND assigned_agent_id IS NULL)::int AS coding_unclaimed,
         count(*) FILTER (WHERE status = 'REVIEW')::int AS review,
         count(*) FILTER (WHERE status = 'RESTART')::int AS restart
       FROM tasks ${taskWhere}`,
      taskParams,
    );
    const queue = queueRows.rows[0];

    // 3) Пропускная способность по событиям (append-only task_events).
    const evWhere = projectDbId
      ? 'JOIN tasks t ON t.id = te.task_id AND t.project_id = $1'
      : '';
    const thr = await c.query(
      `SELECT
         count(*) FILTER (WHERE te.to_status IN ('DONE','CANCELLED')
                          AND te.created_at >= now() - interval '1 hour')::int AS completed_1h,
         count(*) FILTER (WHERE te.to_status IN ('DONE','CANCELLED')
                          AND te.created_at >= now() - interval '24 hours')::int AS completed_24h,
         count(*) FILTER (WHERE te.event_type = 'TASK_CREATED'
                          AND te.created_at >= now() - interval '24 hours')::int AS created_24h
       FROM task_events te ${evWhere}`,
      taskParams,
    );
    const throughput = thr.rows[0];

    // 4) Повторная работа: все переходы со статусом + лишние повторные входы в
    //    один и тот же статус одной задачи (rework).
    const transWhere = projectDbId
      ? 'JOIN tasks t ON t.id = te.task_id AND t.project_id = $1'
      : '';
    const trans = await c.query(
      `WITH e AS (
         SELECT te.task_id, te.to_status
           FROM task_events te ${transWhere}
          WHERE te.to_status IS NOT NULL
       ),
       grp AS (
         SELECT task_id, to_status, count(*)::int AS entries FROM e GROUP BY task_id, to_status
       )
       SELECT
         (SELECT count(*)::int FROM e) AS transitions,
         coalesce(sum(entries - 1) FILTER (WHERE entries > 1), 0)::int AS rework_extra
       FROM grp`,
      taskParams,
    );
    const transitions = trans.rows[0]?.transitions ?? 0;
    const reworkExtra = trans.rows[0]?.rework_extra ?? 0;

    // 5) Средняя длительность завершённых задач (DONE): completed − created.
    const avg = await c.query(
      `SELECT avg(extract(epoch FROM (ev.completed_at - t.created_at)) * 1000) AS avg_ms
         FROM tasks t
         JOIN LATERAL (
           SELECT max(created_at) AS completed_at FROM task_events
            WHERE task_id = t.id AND to_status = 'DONE'
         ) ev ON true
        WHERE t.status = 'DONE' AND ev.completed_at IS NOT NULL
          ${projectDbId ? 'AND t.project_id = $1' : ''}`,
      taskParams,
    );
    const averageCompletedDurationMs =
      avg.rows[0].avg_ms == null ? null : Math.max(0, Math.round(Number(avg.rows[0].avg_ms)));

    // 6/6b) Нагрузка по ролям — период с нуля от последнего деплой-маркера +
    //    сравнение с периодом предпоследнего обновления (ROLE-LOAD-DEPLOY-PERIOD-001,
    //    см. deriveRoleLoadBlock ниже). Текущий период = [последний deploy-маркер; now];
    //    период сравнения = [предпоследний маркер; последний]. По каждому показателю —
    //    дельта {pct, improved} с учётом направленности метрики. Фолбэк без маркеров —
    //    прежнее окно 24ч от последней активности, без сравнения.
    const { roleLoad, roleLoadWindow, roleLoadTaskTotals, roleLoadPeriods } =
      await deriveRoleLoadBlock(c, generatedAt.toISOString());

    // 7) Программист: проходы и упоры в лимит ходов (PROGRAMMER-LIMIT-KPI-001).
    //    avgPasses/maxPasses — «за сколько проходов программист справляется» (numTurns
    //    из событий сдачи, поле passes). limitHits — отдельный KPI: задача не влезла
    //    в бюджет ходов = сигнал плохой нарезки (Декомпозитор/Архитектор). Оба
    //    считаются за 24 часа по append-only task_events.
    const progWhere = projectDbId
      ? 'JOIN tasks t ON t.id = te.task_id AND t.project_id = $1'
      : '';
    const prog = await c.query(
      `SELECT
         avg((te.payload_json->>'passes')::numeric)
           FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL) AS avg_passes,
         max((te.payload_json->>'passes')::int)
           FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL) AS max_passes,
         count(*) FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL)::int AS completions,
         count(*) FILTER (WHERE te.payload_json->>'kind' = 'programmer_limit_exceeded')::int AS limit_hits
       FROM task_events te ${progWhere}
       WHERE te.created_at >= now() - interval '24 hours'
         AND te.payload_json->>'source' IN ('scanner','programmer-runner')`,
      taskParams,
    );
    const programmer = {
      avgPasses: prog.rows[0].avg_passes == null
        ? null : Math.round(Number(prog.rows[0].avg_passes) * 10) / 10,
      maxPasses: prog.rows[0].max_passes == null ? null : Number(prog.rows[0].max_passes),
      completions: prog.rows[0].completions,
      limitHits: prog.rows[0].limit_hits,
    };

    const kpi = deriveKpi({ byStatus, transitions, reworkExtra });

    return {
      generatedAt: generatedAt.toISOString(),
      projectId: projectDbId,
      tasks: {
        byStatus,
        total: kpi.total,
        active: kpi.active,
        blocked: kpi.blocked,
        completed: kpi.completed,
        done: kpi.done,
        cancelled: kpi.cancelled,
        failed: kpi.failed,
      },
      queue: {
        backlog: queue.backlog,
        codingUnclaimed: queue.coding_unclaimed,
        review: queue.review,
        restart: queue.restart,
      },
      throughput: {
        completedLastHour: throughput.completed_1h,
        completedLast24h: throughput.completed_24h,
        createdLast24h: throughput.created_24h,
      },
      rework: {
        transitions: kpi.transitions,
        reworkExtra: kpi.reworkExtra,
        retryRate: kpi.retryRate,
      },
      timings: {
        averageCompletedDurationMs,
      },
      programmer,
      roleLoad,
      roleLoadWindow,
      roleLoadTaskTotals,
      roleLoadPeriods,
      connector: connectorBuckets(),
    };
  });
}

// =====================================================================
// ROLE-LOAD-LAST-DATA-001 / ROLE-LOAD-AVG-001 — блок «Нагрузка по ролям».
//
// Три доработки блока:
//  1) окно якорится к последней активности (см. getPerformanceMetrics, шаг 6);
//  2) основной вид — средние на задачу (deriveRoleLoad ниже);
//  3) отдельная вкладка «Суммы» с суммарными значениями по периодам
//     месяц/неделя/день (getRoleLoadTotals + buildRoleLoadTotals).
// =====================================================================

// Периоды вкладки «Суммы» → скользящее окно в днях, заякоренное к последней
// активности (как и основной вид), чтобы простой оркестратора не обнулял блок.
export const ROLE_LOAD_PERIOD_DAYS = { month: 30, week: 7, day: 1 };

// =====================================================================
// RELEASE-OUTCOMES-001 — «Возвраты захвата» против «настоящего провала агента».
//
// Инцидент 03.07.2026: releaseClaudeTask (db.js, PROGRAMMER-UNIFY-001) финализирует
// RUNNING-прогон программиста как status='FAILED' при ЛЮБОМ освобождении захвата.
// Плановый возврат захвата в пул (петля захват→release каждые ~5 c по одной задаче)
// писал outcome='released', а агрегат «Нагрузка по ролям» считал все FAILED как
// «Провал» — 1408, из них 1407 ложных по одной задаче. Здесь на стороне чтения
// отделяем служебные исходы освобождения захвата («Возвраты») от настоящего провала
// кода агента («Провал»). db.js НЕ меняем: outcome пишется корректно уже сейчас.
//
// КЛАССИФИКАЦИЯ ИЗВЕСТНЫХ ЗНАЧЕНИЙ outcome (сверено с db.js на 03.07.2026):
//   Возвраты (RELEASE_OUTCOMES) — освобождение захвата без результата агента:
//     'released'                       — releaseClaudeTask при пустом reason: плановый
//                                        возврат захвата в пул (ИМЕННО он дал 1407
//                                        ложных «провалов»); пишется как FAILED.
//     'claude_assignment_timeout'      — releaseStaleClaudeClaims: назначение протухло
//                                        (пишется как status='TIMEOUT').
//     'orchestrator_restart_reconcile' — reapOrphanRunningRuns: рестарт процесса
//                                        (пишется как status='TIMEOUT').
//     'orphan_run_timeout'             — reapOrphanRunningRuns: осиротевший RUNNING
//                                        (пишется как status='TIMEOUT').
//   Провал (НЕ в наборе) — настоящий провал агента, остаётся в колонке «Провал»:
//     'max_turns_exceeded'             — упор в лимит ходов (status='FAILED').
//     'agent_reported_failure[: ...]'  — агент сам сообщил о провале (status='FAILED').
//     'verdict_unparsed'               — роль не вернула валидный вердикт (status='FAILED').
//     любой иной непустой либо NULL outcome — трактуется как настоящий провал.
// Из перечисленного как FAILED реально пишется только 'released'; прочие служебные
// исходы пишутся как TIMEOUT и в «Провал» не попадают. Включение их в набор безопасно
// и future-proof: если путь освобождения когда-нибудь начнёт писать FAILED — он
// автоматически уйдёт в «Возвраты». Появится новый reason освобождения захвата —
// добавить сюда (иначе он снова замаскируется под провал). Сравнение в SQL и в
// isReleaseOutcome() — по lower(outcome), поэтому набор храним в нижнем регистре.
export const RELEASE_OUTCOMES = [
  'released',
  'claude_assignment_timeout',
  'orchestrator_restart_reconcile',
  'orphan_run_timeout',
];

/**
 * ЧИСТЫЙ предикат «этот outcome — служебный возврат захвата, а не провал агента».
 * Регистронезависимо, с обрезкой пробелов. NULL/пустой outcome → false (это провал:
 * у 'released' outcome всегда задан, а настоящему провалу с NULL-исходом место в
 * «Провал»). Эталон набора — RELEASE_OUTCOMES выше. Дублирует SQL-фильтр FILTER(...)
 * шага 6, вынесен отдельно для юнит-теста классификации без БД.
 * @param {string|null|undefined} outcome значение agent_runs.outcome
 * @returns {boolean}
 */
export function isReleaseOutcome(outcome) {
  if (outcome == null) return false;
  return RELEASE_OUTCOMES.includes(String(outcome).trim().toLowerCase());
}

/**
 * ЧИСТЫЙ маппинг сырых строк агрегата ролей в основной («средние на задачу») вид.
 * Вынесен для юнит-теста без БД. Средние = sum(метрика) / count(DISTINCT task_id);
 * при tasks = 0 (нет task_id по всем прогонам роли) среднее = null (в UI «—»).
 * Суммарные поля (tokensIn/tokensOut/cost и разбивка кэша) сохраняются для
 * вкладки «Суммы» и совместимости.
 * @param {Array<Object>} rows сырые строки (по одной на роль)
 * @returns {Array<Object>}
 */
export function deriveRoleLoad(rows = []) {
  return rows.map((row) => {
    const tasks = Number(row.tasks) || 0;
    const tokensIn = Number(row.tokens_in) || 0;
    const tokensOut = Number(row.tokens_out) || 0;
    const cost = Number(row.cost) || 0;
    const cacheRead = Number(row.tokens_cache_read) || 0;
    const cacheCreation = Number(row.tokens_cache_creation) || 0;
    // Свежий ≥ 0: у исторических прогонов разбивки нет (cache-поля = 0) → fresh = tokensIn.
    const inputFresh = Math.max(0, tokensIn - cacheRead - cacheCreation);
    const avgInt = (v) => (tasks > 0 ? Math.round(v / tasks) : null);
    return {
      roleCode: row.role_code,
      roleName: row.role_name,
      runs: Number(row.runs) || 0,
      // Задач в окне (для знаменателя средних и подписи в UI).
      tasks,
      success: Number(row.success) || 0,
      // RELEASE-OUTCOMES-001: «Провал» — только настоящие провалы агента (FAILED с
      // outcome НЕ из RELEASE_OUTCOMES). «Возвраты» — служебные возвраты захвата
      // (FAILED с outcome из набора). Разделение считает SQL шага 6; здесь — маппинг.
      failed: Number(row.failed) || 0,
      returns: Number(row.returns) || 0,
      timeout: Number(row.timeout) || 0,
      running: Number(row.running) || 0,
      avgDurationMs: row.avg_ms == null ? null : Math.round(Number(row.avg_ms)),
      // Суммарные значения (используются вкладкой «Суммы» и для разбивки кэша).
      tokensIn,
      tokensOut,
      cost,
      // TOKEN-SPLIT-001: деление входа. cacheRead — чтение из кэша (billed ~10%,
      // копится по ходам tool-loop и обычно доминирует), cacheCreation — запись
      // в кэш (~125%), inputFresh — свежий (uncached) ввод. Сумма трёх = tokensIn.
      tokensCacheRead: cacheRead,
      tokensCacheCreation: cacheCreation,
      tokensInputFresh: inputFresh,
      // ROLE-LOAD-AVG-001: средние на задачу для основного вида (null при tasks = 0).
      avgTokensInPerTask: avgInt(tokensIn),
      avgTokensOutPerTask: avgInt(tokensOut),
      avgCostPerTask: tasks > 0 ? Math.round((cost / tasks) * 1e6) / 1e6 : null,
      avgColdStartMs: row.avg_cold_start_ms == null ? null : Math.round(Number(row.avg_cold_start_ms)),
    };
  });
}

/**
 * ЧИСТЫЙ расчёт границ окна и признака «устаревания» блока по последней активности.
 * Вынесен для юнит-теста без БД. stale = данные старше окна относительно now
 * (оркестратор простаивает дольше окна, но последние данные всё равно показываются).
 * @param {string|null} lastActivityISO время последнего прогона (max started_at)
 * @param {string} nowISO текущее время среза
 * @param {number} windowHours ширина окна в часах (24 для основного вида)
 * @returns {{stale:boolean, staleHours:number, windowStart:string|null, windowEnd:string|null, lastActivityAt:string|null}}
 */
export function computeRoleLoadWindow(lastActivityISO, nowISO, windowHours = 24) {
  if (lastActivityISO == null) {
    return { stale: false, staleHours: 0, windowStart: null, windowEnd: null, lastActivityAt: null };
  }
  const last = new Date(lastActivityISO);
  const now = new Date(nowISO);
  const windowMs = windowHours * 3.6e6;
  const gapMs = now.getTime() - last.getTime();
  const stale = Number.isFinite(gapMs) && gapMs > windowMs;
  const start = new Date(last.getTime() - windowMs);
  return {
    stale,
    staleHours: stale ? Number((gapMs / 3.6e6).toFixed(1)) : 0,
    windowStart: start.toISOString(),
    windowEnd: last.toISOString(),
    lastActivityAt: last.toISOString(),
  };
}

/**
 * ЧИСТЫЙ маппинг сырых строк суммарного агрегата ролей (вкладка «Суммы»).
 * Вынесен для юнит-теста без БД. Здесь всё суммарно за период, без усреднения.
 * @param {Array<Object>} rows сырые строки (по одной на роль)
 * @returns {Array<Object>}
 */
export function buildRoleLoadTotals(rows = []) {
  return rows.map((row) => ({
    roleCode: row.role_code,
    roleName: row.role_name,
    runs: Number(row.runs) || 0,
    tasks: Number(row.tasks) || 0,
    success: Number(row.success) || 0,
    // RELEASE-OUTCOMES-001: те же «Провал» (настоящие) и «Возвраты» (возврат захвата).
    failed: Number(row.failed) || 0,
    returns: Number(row.returns) || 0,
    timeout: Number(row.timeout) || 0,
    tokensIn: Number(row.tokens_in) || 0,
    tokensOut: Number(row.tokens_out) || 0,
    cost: Math.round((Number(row.cost) || 0) * 1e6) / 1e6,
  }));
}

/**
 * ROLE-LOAD-TASK-TOTALS-001 — ЧИСТЫЙ маппинг агрегата «Итого (полная задача)».
 * Вынесен для юнит-теста без БД. Вход — одна строка агрегата по DONE-задачам окна:
 * tasks (размер совокупности) и средние ПОЛНЫХ сумм на задачу (avg_cost,
 * avg_tokens_in, avg_tokens_out, avg_work_ms — суммарное время работы всех ролей)
 * плюс сквозное календарное время создание→DONE (avg_lead_ms). Стоимость
 * округляется до 6 знаков, токены/мс — до целого. При tasks = 0 совокупность пуста
 * → все средние = null (в UI «—»). Это ИСТИННОЕ сквозное среднее по задачам, а не
 * сумма независимых средних по ролям (последнее ЗАПРЕЩЕНО методикой).
 * @param {Object} row сырая строка агрегата (одна на всё окно)
 * @returns {{tasks:number, avgCost:number|null, avgTokensIn:number|null, avgTokensOut:number|null, avgWorkMs:number|null, avgLeadMs:number|null}}
 */
export function buildRoleLoadTaskTotals(row = {}) {
  const tasks = Number(row?.tasks) || 0;
  if (tasks <= 0) {
    return { tasks: 0, avgCost: null, avgTokensIn: null, avgTokensOut: null, avgWorkMs: null, avgLeadMs: null };
  }
  const roundInt = (v) => (v == null ? null : Math.round(Number(v)));
  return {
    tasks,
    avgCost: row.avg_cost == null ? null : Math.round(Number(row.avg_cost) * 1e6) / 1e6,
    avgTokensIn: roundInt(row.avg_tokens_in),
    avgTokensOut: roundInt(row.avg_tokens_out),
    avgWorkMs: roundInt(row.avg_work_ms),
    avgLeadMs: roundInt(row.avg_lead_ms),
  };
}

// =====================================================================
// ROLE-LOAD-DEPLOY-PERIOD-001 — период с нуля от последнего обновления + сравнение
// с предыдущим. Блок «Нагрузка по ролям» считается заново от последнего deploy-
// маркера kpi_markers (текущий период = [последний маркер; now]); рядом с каждым
// показателем — дельта к периоду предпоследнего обновления ([предпоследний; последний]).
// Направленность метрик обязательна: рост «Успех» = улучшение (зелёная стрелка),
// рост «Провал»/«Таймаут»/«Ср. время»/средних токенов/стоимости = ухудшение (красная).
// =====================================================================

// Направленность показателей вида «Средние на задачу». lowerIsBetter=true → рост =
// ухудшение (красная стрелка). Нейтральные счётчики (runs/tasks/running) здесь НЕ
// перечислены — для них дельта не считается и не показывается (решение архитектора).
// rate:true — СЫРОЙ счётчик за период: сравнивать дельтой между периодами разной
// длины (текущий [маркер; now] растёт, период сравнения фиксирован) можно только
// после нормировки на длительность периода (см. attachRoleLoadDeltas). Средние
// (avg*) длина-независимы и нормировки не требуют.
export const ROLE_LOAD_METRICS = [
  { key: 'success', lowerIsBetter: false, rate: true },
  { key: 'failed', lowerIsBetter: true, rate: true },
  { key: 'timeout', lowerIsBetter: true, rate: true },
  { key: 'avgDurationMs', lowerIsBetter: true },
  { key: 'avgTokensInPerTask', lowerIsBetter: true },
  { key: 'avgTokensOutPerTask', lowerIsBetter: true },
  { key: 'avgCostPerTask', lowerIsBetter: true },
  { key: 'avgColdStartMs', lowerIsBetter: true },
];

// Направленность строки «Итого (полная задача)». tasks — нейтральный (без дельты).
export const ROLE_LOAD_TASK_TOTALS_METRICS = [
  { key: 'avgCost', lowerIsBetter: true },
  { key: 'avgTokensIn', lowerIsBetter: true },
  { key: 'avgTokensOut', lowerIsBetter: true },
  { key: 'avgWorkMs', lowerIsBetter: true },
  { key: 'avgLeadMs', lowerIsBetter: true },
];

/**
 * ЧИСТЫЙ расчёт дельты одного показателя между текущим и предыдущим периодами.
 * Вынесен для юнит-теста без БД. pct — дробное отношение (b − a)/|a| (0.123 = +12,3%);
 * improved: true = эффективность выросла (зелёный), false = снизилась (красный),
 * null = изменения нет (серый). direction lowerIsBetter=true → рост значения = хуже.
 * Возвращает null, если сравнение невозможно: нет текущего/базового значения или
 * база = 0 (процент не определён) — тогда стрелку и процент не показываем (требование 4).
 * @param {number|null} current значение показателя текущего периода
 * @param {number|null} previous значение показателя периода сравнения
 * @param {boolean} lowerIsBetter true — меньше = лучше
 * @returns {{pct:number, improved:boolean|null}|null}
 */
export function computeMetricDelta(current, previous, lowerIsBetter) {
  if (current == null || previous == null) return null;
  const a = Number(previous);
  const b = Number(current);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return null;
  const pct = Math.round(((b - a) / Math.abs(a)) * 1000) / 1000;
  if (pct === 0) return { pct: 0, improved: null };
  const grew = pct > 0;
  return { pct, improved: lowerIsBetter ? !grew : grew };
}

/**
 * ЧИСТОЕ присоединение дельт к строкам текущего периода по коду роли. Вынесено для
 * юнит-теста без БД. previousRows === null или роль отсутствует в периоде сравнения
 * (в нём нет прогонов этой роли) → delta = null (стрелку не показываем, требование 4).
 * Иначе delta — объект { <metricKey>: {pct, improved}|null } по ROLE_LOAD_METRICS.
 * @param {Array<Object>} currentRows строки текущего периода (после deriveRoleLoad)
 * @param {Array<Object>|null} previousRows строки периода сравнения или null
 * @returns {Array<Object>} те же строки + поле delta
 */
export function attachRoleLoadDeltas(currentRows = [], previousRows = null, periods = null) {
  const prevByCode = new Map();
  if (previousRows) for (const r of previousRows) prevByCode.set(r.roleCode, r);
  // ROLE-LOAD-RATE-DELTA-001: сырые счётчики (rate:true) нормируем на длительность
  // периода, иначе дельта врёт (роль с постоянной частотой провалов показывает
  // «−80% провалов» просто потому, что текущее окно после деплоя короче предыдущего).
  // Длительности переданы — нормируем; нет (юнит-тест без периодов) — как раньше.
  const curMs = Number(periods?.currentDurationMs);
  const prevMs = Number(periods?.previousDurationMs);
  const canRate = Number.isFinite(curMs) && curMs > 0 && Number.isFinite(prevMs) && prevMs > 0;
  return currentRows.map((row) => {
    const prev = previousRows ? prevByCode.get(row.roleCode) : null;
    if (!prev) return { ...row, delta: null };
    const delta = {};
    for (const { key, lowerIsBetter, rate } of ROLE_LOAD_METRICS) {
      const [curV, prevV] = rate && canRate
        ? [row[key] / curMs, prev[key] / prevMs]
        : [row[key], prev[key]];
      delta[key] = computeMetricDelta(curV, prevV, lowerIsBetter);
    }
    return { ...row, delta };
  });
}

/**
 * ЧИСТОЕ присоединение дельты к строке «Итого (полная задача)». Вынесено для юнит-
 * теста без БД. Если периода сравнения нет или в нём нет DONE-задач (previous.tasks
 * не > 0) → delta = null (требование 4). Иначе delta по ROLE_LOAD_TASK_TOTALS_METRICS.
 * @param {Object} current текущий roleLoadTaskTotals (после buildRoleLoadTaskTotals)
 * @param {Object|null} previous roleLoadTaskTotals периода сравнения или null
 * @returns {Object} current + поле delta
 */
export function attachRoleLoadTaskTotalsDelta(current, previous = null) {
  if (!previous || !(Number(previous.tasks) > 0)) return { ...current, delta: null };
  const delta = {};
  for (const { key, lowerIsBetter } of ROLE_LOAD_TASK_TOTALS_METRICS) {
    delta[key] = computeMetricDelta(current[key], previous[key], lowerIsBetter);
  }
  return { ...current, delta };
}

// Последние N деплой-маркеров (общесистемные, role_id IS NULL) по убыванию времени.
// Два верхних дают границы текущего периода и периода сравнения.
async function fetchLastDeployMarkers(c, limit = 2) {
  const r = await c.query(
    `SELECT id, ref, description, created_at
       FROM kpi_markers
      WHERE marker_type = 'deploy' AND role_id IS NULL
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return r.rows.map((row) => ({
    id: row.id, ref: row.ref, description: row.description, createdAt: row.created_at,
  }));
}

// Сырые строки нагрузки по ролям за явный полуинтервал [startISO, endISO).
// Те же поля, что у основного вида; границы задаются параметрами (маркеры/фолбэк).
async function queryRoleLoadRows(c, startISO, endISO) {
  const r = await c.query(
    `SELECT r.code AS role_code, r.name AS role_name,
            count(*)::int AS runs,
            count(DISTINCT ar.task_id)::int AS tasks,
            count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
            -- RELEASE-OUTCOMES-001: FAILED делим на настоящий провал агента и
            -- служебный возврат захвата (outcome из RELEASE_OUTCOMES, $3).
            count(*) FILTER (WHERE ar.status = 'FAILED'
                             AND coalesce(lower(ar.outcome), '') <> ALL($3::text[]))::int AS failed,
            count(*) FILTER (WHERE ar.status = 'FAILED'
                             AND coalesce(lower(ar.outcome), '') = ANY($3::text[]))::int AS returns,
            count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
            count(*) FILTER (WHERE ar.status = 'RUNNING')::int AS running,
            avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
              FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms,
            coalesce(sum(ar.token_input), 0)::bigint AS tokens_in,
            coalesce(sum(ar.token_output), 0)::bigint AS tokens_out,
            coalesce(sum(ar.token_cache_read), 0)::bigint AS tokens_cache_read,
            coalesce(sum(ar.token_cache_creation), 0)::bigint AS tokens_cache_creation,
            coalesce(sum(ar.cost), 0)::numeric AS cost,
            avg(ar.cold_start_ms) FILTER (WHERE ar.cold_start_ms IS NOT NULL) AS avg_cold_start_ms
       FROM agent_runs ar
       JOIN roles r ON r.id = ar.role_id
      WHERE ar.started_at >= $1 AND ar.started_at < $2
      GROUP BY r.code, r.name
      ORDER BY runs DESC`,
    [startISO, endISO, RELEASE_OUTCOMES],
  );
  return r.rows;
}

// Сырой агрегат «Итого (полная задача)» за явный полуинтервал по времени DONE-события
// задачи [startISO, endISO). Логика совпадает с шагом 6b, границы — параметрами.
async function queryRoleLoadTaskTotalsRow(c, startISO, endISO) {
  const r = await c.query(
    `WITH done_tasks AS (
       SELECT t.id AS task_id, t.created_at AS created_at, ev.done_at AS done_at
         FROM tasks t
         JOIN LATERAL (
           SELECT max(created_at) AS done_at FROM task_events
            WHERE task_id = t.id AND to_status = 'DONE'
         ) ev ON true
        WHERE t.status = 'DONE'
          AND ev.done_at IS NOT NULL
          AND ev.done_at >= $1 AND ev.done_at < $2
     ),
     per_task AS (
       SELECT dt.created_at, dt.done_at,
              coalesce(sum(ar.cost), 0) AS task_cost,
              coalesce(sum(ar.token_input), 0) AS task_tokens_in,
              coalesce(sum(ar.token_output), 0) AS task_tokens_out,
              coalesce(sum(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
                       FILTER (WHERE ar.finished_at IS NOT NULL), 0) AS task_work_ms
         FROM done_tasks dt
         LEFT JOIN agent_runs ar ON ar.task_id = dt.task_id
        GROUP BY dt.task_id, dt.created_at, dt.done_at
     )
     SELECT count(*)::int AS tasks,
            avg(task_cost) AS avg_cost,
            avg(task_tokens_in) AS avg_tokens_in,
            avg(task_tokens_out) AS avg_tokens_out,
            avg(task_work_ms) AS avg_work_ms,
            avg(extract(epoch FROM (done_at - created_at)) * 1000) AS avg_lead_ms
       FROM per_task`,
    [startISO, endISO],
  );
  return r.rows[0];
}

/**
 * ROLE-LOAD-DEPLOY-PERIOD-001 — сборка блока «Нагрузка по ролям» по периодам
 * деплой-маркеров. Возвращает { roleLoad, roleLoadWindow, roleLoadTaskTotals,
 * roleLoadPeriods }. Основной путь: последний deploy-маркер задаёт начало текущего
 * периода, предпоследний — период сравнения; по каждому показателю считается дельта.
 * Фолбэк (маркеров нет): прежнее окно 24ч от последней активности, дельт нет — чтобы
 * блок не пустел до первого деплоя.
 * @param {Object} c pg-клиент
 * @param {string} nowISO время среза (generatedAt)
 */
async function deriveRoleLoadBlock(c, nowISO) {
  const markers = await fetchLastDeployMarkers(c, 2);

  if (markers.length === 0) {
    // Фолбэк: деплой-маркеров ещё нет → окно 24ч от последней активности, без сравнения.
    const roleRows = await c.query(
      `WITH bounds AS (SELECT max(started_at) AS last_activity FROM agent_runs)
       SELECT r.code AS role_code, r.name AS role_name,
              count(*)::int AS runs,
              count(DISTINCT ar.task_id)::int AS tasks,
              count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
              -- RELEASE-OUTCOMES-001: FAILED делим на настоящий провал агента и
              -- служебный возврат захвата (outcome из RELEASE_OUTCOMES, $1).
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') <> ALL($1::text[]))::int AS failed,
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') = ANY($1::text[]))::int AS returns,
              count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
              count(*) FILTER (WHERE ar.status = 'RUNNING')::int AS running,
              avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
                FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms,
              coalesce(sum(ar.token_input), 0)::bigint AS tokens_in,
              coalesce(sum(ar.token_output), 0)::bigint AS tokens_out,
              coalesce(sum(ar.token_cache_read), 0)::bigint AS tokens_cache_read,
              coalesce(sum(ar.token_cache_creation), 0)::bigint AS tokens_cache_creation,
              coalesce(sum(ar.cost), 0)::numeric AS cost,
              avg(ar.cold_start_ms) FILTER (WHERE ar.cold_start_ms IS NOT NULL) AS avg_cold_start_ms,
              (SELECT last_activity FROM bounds) AS last_activity
         FROM agent_runs ar
         JOIN roles r ON r.id = ar.role_id
        WHERE ar.started_at >= (SELECT last_activity FROM bounds) - interval '24 hours'
        GROUP BY r.code, r.name
        ORDER BY runs DESC`,
      [RELEASE_OUTCOMES],
    );
    const lastActivity = roleRows.rows[0]?.last_activity ?? null;
    const lastActivityISO = lastActivity ? new Date(lastActivity).toISOString() : null;
    const roleLoad = deriveRoleLoad(roleRows.rows).map((row) => ({ ...row, delta: null }));
    const roleLoadWindow = computeRoleLoadWindow(lastActivityISO, nowISO, 24);
    const taskTotalsRow = await queryRoleLoadTaskTotalsRow(
      c, roleLoadWindow.windowStart, lastActivityISO ?? nowISO,
    );
    return {
      roleLoad,
      roleLoadWindow,
      roleLoadTaskTotals: { ...buildRoleLoadTaskTotals(taskTotalsRow), delta: null },
      roleLoadPeriods: {
        mode: 'fallback', current: null, previous: null, marker: null, previousHasRuns: false,
      },
    };
  }

  const lastMarker = markers[0];
  const prevMarker = markers[1] ?? null;
  const lastISO = new Date(lastMarker.createdAt).toISOString();

  // Текущий период [последний маркер; now].
  const curRoleLoad = deriveRoleLoad(await queryRoleLoadRows(c, lastISO, nowISO));
  const curTaskTotals = buildRoleLoadTaskTotals(await queryRoleLoadTaskTotalsRow(c, lastISO, nowISO));

  // Период сравнения [предпоследний маркер; последний], если он есть.
  let prevRoleLoad = null;
  let prevTaskTotals = null;
  let previous = null;
  if (prevMarker) {
    const prevISO = new Date(prevMarker.createdAt).toISOString();
    prevRoleLoad = deriveRoleLoad(await queryRoleLoadRows(c, prevISO, lastISO));
    prevTaskTotals = buildRoleLoadTaskTotals(await queryRoleLoadTaskTotalsRow(c, prevISO, lastISO));
    previous = { start: prevISO, end: lastISO };
  }

  // Длительности периодов для нормировки сырых счётчиков (см. attachRoleLoadDeltas).
  const currentDurationMs = new Date(nowISO).getTime() - new Date(lastISO).getTime();
  const previousDurationMs = previous
    ? new Date(previous.end).getTime() - new Date(previous.start).getTime()
    : null;

  return {
    roleLoad: attachRoleLoadDeltas(curRoleLoad, prevRoleLoad, { currentDurationMs, previousDurationMs }),
    roleLoadWindow: {
      stale: false, staleHours: 0,
      windowStart: lastISO, windowEnd: nowISO, lastActivityAt: null,
    },
    roleLoadTaskTotals: attachRoleLoadTaskTotalsDelta(curTaskTotals, prevTaskTotals),
    roleLoadPeriods: {
      mode: 'markers',
      current: { start: lastISO, end: nowISO },
      previous,
      marker: { ref: lastMarker.ref, description: lastMarker.description, createdAt: lastISO },
      previousHasRuns: !!(prevRoleLoad && prevRoleLoad.length),
    },
  };
}

/**
 * GET /api/performance/role-load-totals?period=month|week|day — суммарные значения
 * блока «Нагрузка по ролям» за период (месяц/неделя/день). Окно, как и в основном
 * виде, заякорено к последней активности (max(started_at) − N дней), поэтому простой
 * оркестратора не обнуляет вкладку. Роли считаются глобально (как и основной блок).
 */
export async function getRoleLoadTotals(s, { period } = {}) {
  const key = String(period ?? 'month').trim().toLowerCase();
  const normPeriod = Object.prototype.hasOwnProperty.call(ROLE_LOAD_PERIOD_DAYS, key) ? key : 'month';
  const days = ROLE_LOAD_PERIOD_DAYS[normPeriod];
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `WITH bounds AS (SELECT max(started_at) AS last_activity FROM agent_runs)
       SELECT r.code AS role_code, r.name AS role_name,
              count(*)::int AS runs,
              count(DISTINCT ar.task_id)::int AS tasks,
              count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
              -- RELEASE-OUTCOMES-001: FAILED делим на настоящий провал агента и
              -- служебный возврат захвата (outcome из RELEASE_OUTCOMES, $2).
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') <> ALL($2::text[]))::int AS failed,
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') = ANY($2::text[]))::int AS returns,
              count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
              coalesce(sum(ar.token_input), 0)::bigint AS tokens_in,
              coalesce(sum(ar.token_output), 0)::bigint AS tokens_out,
              coalesce(sum(ar.cost), 0)::numeric AS cost,
              (SELECT last_activity FROM bounds) AS last_activity
         FROM agent_runs ar
         JOIN roles r ON r.id = ar.role_id
        WHERE ar.started_at >= (SELECT last_activity FROM bounds) - ($1::int * interval '1 day')
        GROUP BY r.code, r.name
        ORDER BY runs DESC`,
      [days, RELEASE_OUTCOMES],
    );
    const lastActivity = r.rows[0]?.last_activity ?? null;
    const window = computeRoleLoadWindow(
      lastActivity ? new Date(lastActivity).toISOString() : null,
      new Date().toISOString(),
      days * 24,
    );
    return {
      generatedAt: new Date().toISOString(),
      period: normPeriod,
      windowDays: days,
      ...window,
      roles: buildRoleLoadTotals(r.rows),
    };
  });
}

// =====================================================================
// VERSION-KPI-TRACKING-001 — KPI по версиям (код/промт/модель) и дельты.
//
// Отвечает на «поправили код/промт — как изменились показатели роли?». Группируем
// прогоны роли по тройке (prompt_version, code_version, model), считаем средние,
// упорядочиваем по времени первого прогона и считаем дельту к предыдущей версии.
// =====================================================================

// Минимум прогонов на версию, чтобы дельта/регресс считались значимыми (иначе шум
// из 1–2 прогонов). Регресс — рост «метрики-чем-меньше-тем-лучше» сверх порога.
export const VERSION_MIN_SAMPLE = 5;
export const VERSION_REGRESSION_PCT = 0.1;

// Метрики версии и направление «лучше». lowerIsBetter=true → рост = регресс.
const VERSION_METRICS = [
  { key: 'avgDurationMs', lowerIsBetter: true },
  { key: 'avgTokensIn', lowerIsBetter: true },
  { key: 'avgTokensOut', lowerIsBetter: true },
  { key: 'avgCost', lowerIsBetter: true },
  { key: 'avgColdStartMs', lowerIsBetter: true },
  { key: 'avgTurns', lowerIsBetter: true },
  { key: 'avgPasses', lowerIsBetter: true },
  { key: 'successRate', lowerIsBetter: false },
];

/**
 * Чистый расчёт дельт и регрессов по упорядоченному во времени списку версий.
 * Вынесен отдельно для юнит-теста без БД. Для каждой версии (кроме первой) дельта
 * считается к ПРЕДЫДУЩЕЙ. Регресс отмечается только когда у обеих версий выборка
 * не меньше minSample (иначе enoughData=false и regression не выставляется).
 * @param {Array<Object>} rows  версии в хронологическом порядке (поле n — размер выборки)
 * @returns {Array<Object>} те же строки + { delta, enoughData, regression, regressedMetrics }
 */
export function deriveVersionDeltas(rows, { minSample = VERSION_MIN_SAMPLE, regressionPct = VERSION_REGRESSION_PCT } = {}) {
  const out = [];
  for (let i = 0; i < rows.length; i += 1) {
    const cur = rows[i];
    const prev = i > 0 ? rows[i - 1] : null;
    const delta = {};
    const regressedMetrics = [];
    const enoughData = !!prev && Number(prev.n) >= minSample && Number(cur.n) >= minSample;
    for (const { key, lowerIsBetter } of VERSION_METRICS) {
      const a = prev == null ? null : prev[key];
      const b = cur[key];
      if (a == null || b == null) { delta[key] = null; continue; }
      const abs = Math.round((Number(b) - Number(a)) * 1000) / 1000;
      const pct = Number(a) !== 0 ? (Number(b) - Number(a)) / Math.abs(Number(a)) : null;
      delta[key] = { abs, pct: pct == null ? null : Math.round(pct * 1000) / 1000 };
      // Регресс: ухудшение сверх порога (направление зависит от lowerIsBetter).
      if (enoughData && pct != null) {
        const worsePct = lowerIsBetter ? pct : -pct;
        if (worsePct > regressionPct) regressedMetrics.push(key);
      }
    }
    out.push({ ...cur, delta, enoughData, regression: regressedMetrics.length > 0, regressedMetrics });
  }
  return out;
}

/**
 * GET /api/performance/versions?role=CODE[&windowHours=N&projectId=...]
 * Рассуждающие роли агрегируются из agent_runs (есть токены/cold_start/turns).
 * Программист (роль с метриками в task_events) — из событий сдачи: passes/limitHits
 * по code_version/model. role обязателен (версии имеют смысл в разрезе одной роли).
 */
export async function getVersionMetrics(s, { role, windowHours, projectId } = {}) {
  const roleCode = String(role ?? '').trim();
  if (!roleCode) throw badRequest('role_required');
  const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 720;
  return withClient(clientConfig(s), async (c) => {
    const roleRow = await c.query('SELECT id, code, name FROM roles WHERE code = $1', [roleCode]);
    if (!roleRow.rowCount) throw badRequest('role_not_found');
    const role0 = roleRow.rows[0];
    const isProgrammer = roleCode === 'PROGRAMMER';
    const projectDbId = await resolveProjectId(c, projectId);

    const rows = isProgrammer
      ? await programmerVersionRows(c, hours, projectDbId)
      : await reasoningVersionRows(c, role0.id, hours, projectDbId);

    const annotated = deriveVersionDeltas(rows);
    const markers = await fetchMarkers(c, { roleId: role0.id, hours, limit: 100 });
    return {
      generatedAt: new Date().toISOString(),
      role: { code: role0.code, name: role0.name },
      windowHours: hours,
      source: isProgrammer ? 'task_events' : 'agent_runs',
      minSample: VERSION_MIN_SAMPLE,
      regressionPct: VERSION_REGRESSION_PCT,
      versions: annotated,
      markers,
    };
  });
}

// Версии рассуждающей роли из agent_runs, сгруппированные по (prompt_version,
// code_version, model), в хронологии первого прогона.
async function reasoningVersionRows(c, roleId, hours, projectDbId) {
  const params = [roleId, hours];
  let projFilter = '';
  if (projectDbId) {
    params.push(projectDbId);
    projFilter = `AND ar.task_id IN (SELECT id FROM tasks WHERE project_id = $${params.length})`;
  }
  // RELEASE-OUTCOMES-001: набор служебных исходов освобождения захвата отдельным
  // параметром (индекс зависит от наличия projectId выше). Рассуждающие роли
  // 'released' не пишут (это исход PROGRAMMER), но split держим единообразным и
  // future-proof, чтобы «failed» версии не смешивал провал агента с возвратом захвата.
  params.push(RELEASE_OUTCOMES);
  const relIdx = params.length;
  const r = await c.query(
    `SELECT ar.prompt_version, ar.code_version, ar.model,
            (SELECT label FROM prompts p WHERE p.role_id = $1 AND p.version = ar.prompt_version LIMIT 1) AS prompt_label,
            count(*)::int AS n,
            count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
            count(*) FILTER (WHERE ar.status = 'FAILED'
                             AND coalesce(lower(ar.outcome), '') <> ALL($${relIdx}::text[]))::int AS failed,
            count(*) FILTER (WHERE ar.status = 'FAILED'
                             AND coalesce(lower(ar.outcome), '') = ANY($${relIdx}::text[]))::int AS returns,
            count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
            avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
              FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms,
            avg(ar.token_input) FILTER (WHERE ar.token_input IS NOT NULL) AS avg_tokens_in,
            avg(ar.token_output) FILTER (WHERE ar.token_output IS NOT NULL) AS avg_tokens_out,
            avg(ar.cost) FILTER (WHERE ar.cost IS NOT NULL) AS avg_cost,
            avg(ar.cold_start_ms) FILTER (WHERE ar.cold_start_ms IS NOT NULL) AS avg_cold_start,
            avg(ar.turns) FILTER (WHERE ar.turns IS NOT NULL) AS avg_turns,
            min(ar.started_at) AS first_run, max(ar.started_at) AS last_run
       FROM agent_runs ar
      WHERE ar.role_id = $1
        AND ar.started_at >= now() - ($2::int * interval '1 hour')
        ${projFilter}
      GROUP BY ar.prompt_version, ar.code_version, ar.model
      ORDER BY min(ar.started_at)`,
    params,
  );
  return r.rows.map((row) => ({
    promptVersion: row.prompt_version,
    promptLabel: row.prompt_label,
    codeVersion: row.code_version,
    model: row.model,
    n: row.n,
    success: row.success,
    failed: row.failed,
    returns: row.returns,
    timeout: row.timeout,
    successRate: row.n > 0 ? Math.round((row.success / row.n) * 1000) / 1000 : null,
    avgDurationMs: numOrNull(row.avg_ms, 0),
    avgTokensIn: numOrNull(row.avg_tokens_in, 0),
    avgTokensOut: numOrNull(row.avg_tokens_out, 0),
    avgCost: numOrNull(row.avg_cost, 4),
    avgColdStartMs: numOrNull(row.avg_cold_start, 0),
    avgTurns: numOrNull(row.avg_turns, 1),
    avgPasses: null,
    firstRun: row.first_run, lastRun: row.last_run,
  }));
}

// Версии программиста из событий сдачи: passes/limitHits по (code_version, model).
async function programmerVersionRows(c, hours, projectDbId) {
  const params = [hours];
  let projFilter = '';
  if (projectDbId) {
    params.push(projectDbId);
    projFilter = `AND te.task_id IN (SELECT id FROM tasks WHERE project_id = $${params.length})`;
  }
  const r = await c.query(
    `SELECT te.payload_json->>'codeVersion' AS code_version,
            te.payload_json->>'model' AS model,
            count(*) FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL)::int AS n,
            avg((te.payload_json->>'passes')::numeric)
              FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL) AS avg_passes,
            max((te.payload_json->>'passes')::int)
              FILTER (WHERE (te.payload_json->>'passes') IS NOT NULL) AS max_passes,
            count(*) FILTER (WHERE te.payload_json->>'kind' = 'programmer_limit_exceeded')::int AS limit_hits,
            min(te.created_at) AS first_run, max(te.created_at) AS last_run
       FROM task_events te
      WHERE te.created_at >= now() - ($1::int * interval '1 hour')
        AND te.payload_json->>'source' IN ('scanner','programmer-runner')
        ${projFilter}
      GROUP BY te.payload_json->>'codeVersion', te.payload_json->>'model'
      ORDER BY min(te.created_at)`,
    params,
  );
  return r.rows.map((row) => ({
    promptVersion: null,
    promptLabel: null,
    codeVersion: row.code_version,
    model: row.model,
    n: row.n,
    limitHits: row.limit_hits,
    maxPasses: row.max_passes == null ? null : Number(row.max_passes),
    successRate: null,
    avgDurationMs: null,
    avgTokensIn: null,
    avgTokensOut: null,
    avgCost: null,
    avgColdStartMs: null,
    avgTurns: null,
    avgPasses: numOrNull(row.avg_passes, 1),
    firstRun: row.first_run, lastRun: row.last_run,
  }));
}

// =====================================================================
// PROGRAMMER-KIND-STATS-001 — разрез программиста по типу задачи (task_kind) и
// модели. Валидирует выигрыш модель-роутинга (PROGRAMMER-MODEL-ROUTING-001): мелкая
// подзадача-на-файл (subtask) едет на дефолт-простой модели (Sonnet), цельная
// задача-на-сервис (service) — на сложной (Opus). Считаем средние cost/turns/tokens/
// cold-start по (task_kind × model) из agent_runs (там уже лежат usage/cold_start/
// turns программиста, PROGRAMMER-USAGE-KPI-001) — видно, что Sonnet на мелочи дешевле
// и не хуже по проходам.
// =====================================================================

/**
 * ЧИСТЫЙ маппинг сырых строк агрегата (task_kind × model) в вид для UI. Вынесен для
 * юнит-теста без БД. successRate = success/runs; средние округляются; нет данных →
 * поле null («—» в UI). Служебные «Возвраты» (returns) отделены от «Провала» (failed),
 * как и в блоке ролей (RELEASE-OUTCOMES-001).
 * @param {Array<Object>} rows сырые строки (по одной на task_kind×model)
 * @returns {Array<Object>}
 */
export function buildProgrammerKindStats(rows = []) {
  return rows.map((row) => {
    const runs = Number(row.runs) || 0;
    const success = Number(row.success) || 0;
    const failed = Number(row.failed) || 0;
    const timeout = Number(row.timeout) || 0;
    // successRate — по РЕАЛЬНЫМ попыткам (success+failed+timeout), БЕЗ служебных
    // возвратов захвата (returns): они не попытки агента, а backoff-churn пула, и в
    // знаменателе дают ложно-низкий процент (инцидент 03.07: 1407 возвратов маскировались
    // под провалы). runs (все прогоны) отдаём отдельным столбцом для полноты.
    const attempts = success + failed + timeout;
    return {
      taskKind: row.task_kind ?? null,
      model: row.model ?? null,
      runs,
      tasks: Number(row.tasks) || 0,
      success,
      failed,
      returns: Number(row.returns) || 0,
      timeout,
      successRate: attempts > 0 ? Math.round((success / attempts) * 1000) / 1000 : null,
      avgTurns: numOrNull(row.avg_turns, 1),
      avgCost: numOrNull(row.avg_cost, 4),
      avgTokensIn: numOrNull(row.avg_tokens_in, 0),
      avgTokensOut: numOrNull(row.avg_tokens_out, 0),
      avgColdStartMs: numOrNull(row.avg_cold_start, 0),
      avgDurationMs: numOrNull(row.avg_ms, 0),
    };
  });
}

/**
 * GET /api/performance/programmer-by-kind?windowHours=N[&projectId=...]
 * Разрез программиста по (task_kind × model) из agent_runs за окно (дефолт 720ч).
 */
export async function getProgrammerKindStats(s, { windowHours, projectId } = {}) {
  const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 720;
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    const params = [hours, RELEASE_OUTCOMES];
    let projFilter = '';
    if (projectDbId) {
      params.push(projectDbId);
      projFilter = `AND ar.task_id IN (SELECT id FROM tasks WHERE project_id = $${params.length})`;
    }
    const r = await c.query(
      `SELECT t.task_kind, ar.model,
              count(*)::int AS runs,
              count(DISTINCT ar.task_id)::int AS tasks,
              count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') <> ALL($2::text[]))::int AS failed,
              count(*) FILTER (WHERE ar.status = 'FAILED'
                               AND coalesce(lower(ar.outcome), '') = ANY($2::text[]))::int AS returns,
              count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
              avg(ar.turns) FILTER (WHERE ar.turns IS NOT NULL) AS avg_turns,
              avg(ar.cost) FILTER (WHERE ar.cost IS NOT NULL) AS avg_cost,
              avg(ar.token_input) FILTER (WHERE ar.token_input IS NOT NULL) AS avg_tokens_in,
              avg(ar.token_output) FILTER (WHERE ar.token_output IS NOT NULL) AS avg_tokens_out,
              avg(ar.cold_start_ms) FILTER (WHERE ar.cold_start_ms IS NOT NULL) AS avg_cold_start,
              avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
                FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms
         FROM agent_runs ar
         JOIN roles r ON r.id = ar.role_id
         JOIN tasks t ON t.id = ar.task_id
        WHERE r.code = 'PROGRAMMER'
          AND ar.started_at >= now() - ($1::int * interval '1 hour')
          ${projFilter}
        GROUP BY t.task_kind, ar.model
        ORDER BY t.task_kind NULLS LAST, runs DESC`,
      params,
    );
    return {
      generatedAt: new Date().toISOString(),
      windowHours: hours,
      projectId: projectDbId,
      rows: buildProgrammerKindStats(r.rows),
    };
  });
}

// =====================================================================
// ROLE-ENGINE-ROUTING-002 — дневная статистика по коннекторам/моделям.
//
// Отвечает на «сменили модель/коннектор внутри дня — как изменились скорость,
// ошибки, токены, стоимость, успешность?». Группируем прогоны agent_runs по
// (календарный день × снимок connector/provider/model/driver × роль) на основе
// НЕИЗМЕНЯЕМОГО снимка коннектора (snapshot_*), а не текущего названия роли —
// поэтому две разные модели за один день дают ДВЕ отдельные строки. День берётся
// в UTC ровно тем выражением, что в индексе idx_agent_runs_day_provider_model.
// =====================================================================

/**
 * ЧИСТАЯ группировка сырых агрегатов в «день → [модель/коннектор]» (без БД).
 * Вынесена отдельно для юнит-теста маппинга и расчёта производных (successRate,
 * avgTokens, avgCost) и дневных итогов. Порядок дней и строк внутри дня сохраняется
 * как во входе (SQL сортирует день DESC, затем runs DESC).
 * @param {Array<Object>} rows  сырые строки агрегата (по одной на день×коннектор×роль)
 * @returns {Array<{day, totals, models}>}
 */
export function buildDailyModelStats(rows = []) {
  const order = [];
  const byDay = new Map();
  for (const row of rows) {
    const day = row.day == null ? null : String(row.day);
    const runs = Number(row.runs) || 0;
    const success = Number(row.success) || 0;
    const tokensIn = Number(row.tokensIn) || 0;
    const tokensOut = Number(row.tokensOut) || 0;
    const cost = Number(row.cost) || 0;
    const entry = {
      // Источник истины: фактический снимок коннектора, а не имя роли.
      connectorId: row.connectorId ?? null,
      provider: row.provider ?? null,
      model: row.model ?? null,
      driverType: row.driverType ?? null,
      roleCode: row.roleCode ?? null,
      roleName: row.roleName ?? null,
      runs,
      success,
      // RELEASE-OUTCOMES-001: настоящий провал агента и служебный возврат захвата.
      failed: Number(row.failed) || 0,
      returns: Number(row.returns) || 0,
      timeout: Number(row.timeout) || 0,
      throttle: Number(row.throttle) || 0,
      running: Number(row.running) || 0,
      successRate: runs > 0 ? Math.round((success / runs) * 1000) / 1000 : null,
      avgDurationMs: numOrNull(row.avgMs, 0),
      medianDurationMs: numOrNull(row.medianMs, 0),
      tokensIn,
      tokensOut,
      avgTokens: runs > 0 ? Math.round((tokensIn + tokensOut) / runs) : null,
      cost: Math.round(cost * 1e6) / 1e6,
      avgCost: runs > 0 ? Math.round((cost / runs) * 1e6) / 1e6 : null,
    };
    if (!byDay.has(day)) { byDay.set(day, []); order.push(day); }
    byDay.get(day).push(entry);
  }
  return order.map((day) => {
    const models = byDay.get(day);
    const totals = models.reduce((acc, m) => {
      acc.runs += m.runs; acc.success += m.success; acc.failed += m.failed;
      acc.returns += m.returns;
      acc.timeout += m.timeout; acc.throttle += m.throttle; acc.running += m.running;
      acc.tokensIn += m.tokensIn; acc.tokensOut += m.tokensOut; acc.cost += m.cost;
      return acc;
    }, { runs: 0, success: 0, failed: 0, returns: 0, timeout: 0, throttle: 0, running: 0, tokensIn: 0, tokensOut: 0, cost: 0 });
    totals.cost = Math.round(totals.cost * 1e6) / 1e6;
    totals.successRate = totals.runs > 0 ? Math.round((totals.success / totals.runs) * 1000) / 1000 : null;
    totals.models = models.length;
    return { day, totals, models };
  });
}

/**
 * GET /api/performance/daily-models?windowDays=N[&projectId=...] — дневная
 * статистика прогонов в разрезе коннектор/провайдер/модель/драйвер. Frontend НЕ
 * угадывает модель по роли — берёт фактический снимок из agent_runs.snapshot_*.
 */
export async function getDailyModelStats(s, { projectId, windowDays } = {}) {
  // Дробный windowDays в (0;1) проходил guard > 0, но Math.trunc давал 0 → SQL
  // now() - 0*interval = now() → пустое окно. Нижняя граница — минимум 1 день.
  const days = Number.isFinite(Number(windowDays)) && Number(windowDays) > 0
    ? Math.min(365, Math.max(1, Math.trunc(Number(windowDays)))) : 7;
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    const params = [days];
    let projFilter = '';
    if (projectDbId) {
      params.push(projectDbId);
      projFilter = `AND ar.task_id IN (SELECT id FROM tasks WHERE project_id = $${params.length})`;
    }
    // RELEASE-OUTCOMES-001: набор служебных исходов освобождения захвата отдельным
    // параметром (индекс зависит от наличия projectId выше).
    params.push(RELEASE_OUTCOMES);
    const relIdx = params.length;
    // День — ровно выражение из индекса (date_trunc по timestamp в UTC). Медиана
    // без FILTER: неоконченным прогонам длительность = NULL, percentile_cont их
    // игнорирует. throttle не отдельный статус enum — классифицируем по outcome.
    const r = await c.query(
      `SELECT
         to_char(date_trunc('day', ar.started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day,
         ar.snapshot_connector_id::text AS connector_id,
         ar.snapshot_provider AS provider,
         ar.snapshot_model AS model,
         ar.snapshot_driver_type AS driver_type,
         r.code AS role_code, r.name AS role_name,
         count(*)::int AS runs,
         count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
         -- RELEASE-OUTCOMES-001: «Провал» — настоящий провал агента, «Возвраты» —
         -- служебный возврат захвата (outcome из RELEASE_OUTCOMES). Иначе PROGRAMMER
         -- на снимке модели показывал бы 1408 «провалов» вместо 1.
         count(*) FILTER (WHERE ar.status = 'FAILED'
                          AND coalesce(lower(ar.outcome), '') <> ALL($${relIdx}::text[]))::int AS failed,
         count(*) FILTER (WHERE ar.status = 'FAILED'
                          AND coalesce(lower(ar.outcome), '') = ANY($${relIdx}::text[]))::int AS returns,
         count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
         count(*) FILTER (WHERE ar.outcome ILIKE '%throttle%')::int AS throttle,
         count(*) FILTER (WHERE ar.status = 'RUNNING')::int AS running,
         avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
           FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms,
         percentile_cont(0.5) WITHIN GROUP (
           ORDER BY CASE WHEN ar.finished_at IS NOT NULL
                         THEN extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000 END
         ) AS median_ms,
         coalesce(sum(ar.token_input), 0)::bigint AS tokens_in,
         coalesce(sum(ar.token_output), 0)::bigint AS tokens_out,
         coalesce(sum(ar.cost), 0)::numeric AS cost
       FROM agent_runs ar
       LEFT JOIN roles r ON r.id = ar.role_id
      WHERE ar.started_at >= now() - ($1::int * interval '1 day')
        ${projFilter}
      GROUP BY 1, ar.snapshot_connector_id, ar.snapshot_provider, ar.snapshot_model,
               ar.snapshot_driver_type, r.code, r.name
      ORDER BY 1 DESC, runs DESC`,
      params,
    );
    const rows = r.rows.map((row) => ({
      day: row.day,
      connectorId: row.connector_id,
      provider: row.provider,
      model: row.model,
      driverType: row.driver_type,
      roleCode: row.role_code,
      roleName: row.role_name,
      runs: row.runs,
      success: row.success,
      failed: row.failed,
      returns: row.returns,
      timeout: row.timeout,
      throttle: row.throttle,
      running: row.running,
      avgMs: row.avg_ms,
      medianMs: row.median_ms,
      tokensIn: row.tokens_in,
      tokensOut: row.tokens_out,
      cost: row.cost,
    }));
    return {
      generatedAt: new Date().toISOString(),
      projectId: projectDbId,
      windowDays: days,
      days: buildDailyModelStats(rows),
    };
  });
}

/**
 * GET /api/kpi-markers?role=CODE&windowHours=N&limit=M — метки на оси времени
 * (правка промта/деплой/ручная отметка) для вертикальных линий на графиках KPI.
 */
export async function getKpiMarkers(s, { role, windowHours, limit } = {}) {
  const hours = Number.isFinite(Number(windowHours)) && Number(windowHours) > 0 ? Number(windowHours) : 720;
  const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(500, Number(limit)) : 200;
  return withClient(clientConfig(s), async (c) => {
    let roleId = null;
    const roleCode = String(role ?? '').trim();
    if (roleCode) {
      const rr = await c.query('SELECT id FROM roles WHERE code = $1', [roleCode]);
      roleId = rr.rowCount ? rr.rows[0].id : '00000000-0000-0000-0000-000000000000';
    }
    return { generatedAt: new Date().toISOString(), markers: await fetchMarkers(c, { roleId, hours, limit: lim }) };
  });
}

async function fetchMarkers(c, { roleId = null, hours = 720, limit = 200 } = {}) {
  const params = [hours, limit];
  let roleFilter = '';
  if (roleId) {
    params.push(roleId);
    // Метки роли + общесистемные (role_id IS NULL, например деплой).
    roleFilter = `AND (m.role_id = $${params.length} OR m.role_id IS NULL)`;
  }
  const r = await c.query(
    `SELECT m.id, m.marker_type, m.ref, m.description, m.created_at, r.code AS role_code
       FROM kpi_markers m LEFT JOIN roles r ON r.id = m.role_id
      WHERE m.created_at >= now() - ($1::int * interval '1 hour') ${roleFilter}
      ORDER BY m.created_at DESC
      LIMIT $2`,
    params,
  );
  return r.rows.map((row) => ({
    id: row.id, type: row.marker_type, ref: row.ref,
    description: row.description, roleCode: row.role_code, createdAt: row.created_at,
  }));
}

// POST /api/kpi-markers — ручная/деплой-метка (например, после выкатки кода).
export async function createKpiMarker(s, input) {
  const type = String(input?.type ?? 'manual').trim().slice(0, 40) || 'manual';
  const ref = input?.ref == null ? null : String(input.ref).trim().slice(0, 120) || null;
  const description = input?.description == null ? null : String(input.description).trim().slice(0, 500) || null;
  const roleCode = String(input?.role ?? '').trim();
  return withClient(clientConfig(s), async (c) => {
    let roleId = null;
    if (roleCode) {
      const rr = await c.query('SELECT id FROM roles WHERE code = $1', [roleCode]);
      if (!rr.rowCount) throw badRequest('role_not_found');
      roleId = rr.rows[0].id;
    }
    const ins = await c.query(
      `INSERT INTO kpi_markers (role_id, marker_type, ref, description)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [roleId, type, ref, description],
    );
    return { id: ins.rows[0].id, type, ref, description, roleCode: roleCode || null, createdAt: ins.rows[0].created_at };
  });
}

// VERSION-KPI-TRACKING-001 — самоотметка деплоя на старте оркестратора. Пишет
// общесистемную метку type=deploy с git-SHA образа (APP_CODE_VERSION). Идемпотентно
// по ref: повторный рестарт того же образа НЕ плодит метки (вертикальная линия на
// графике появляется ровно один раз на версию кода). Возвращает { created, ref }.
export async function recordDeployMarker(s, { ref, description = null } = {}) {
  const version = String(ref ?? '').trim().slice(0, 120);
  if (!version) return { created: false, ref: null };
  return withClient(clientConfig(s), async (c) => {
    const exists = await c.query(
      `SELECT 1 FROM kpi_markers WHERE marker_type = 'deploy' AND ref = $1 LIMIT 1`,
      [version],
    );
    if (exists.rowCount) return { created: false, ref: version };
    await c.query(
      `INSERT INTO kpi_markers (role_id, marker_type, ref, description)
       VALUES (NULL, 'deploy', $1, $2)`,
      [version, description || `Деплой оркестратора ${version}`],
    );
    return { created: true, ref: version };
  });
}

// ORCH-DOWNTIME-MARKER-001 — «метки, когда оркестратор выключен». Живой процесс
// каждый тик обновляет heartbeat (app_settings.orchestrator_last_seen). Пока сервис
// лежал (контейнер/процесс не работал), heartbeat не бьётся — на следующем старте
// разрыв now−last_seen > порога распознаётся как ПРОСТОЙ и превращается в метку
// type='downtime'. Это отделяет реальные зависания задач от периодов, когда
// оркестратор просто не работал (иначе застойные stage-таймеры выглядят как баг).
const HEARTBEAT_KEY = 'orchestrator_last_seen';

// Чистое решение «был ли простой» по last_seen/now/порогу (тестируется без БД).
// Возвращает { downtime, ref, hours } — ref канонизирует интервал для идемпотентности.
export function computeDowntime(lastSeenISO, nowISO, thresholdMs = 600000) {
  if (lastSeenISO == null) return { downtime: false, ref: null, hours: 0 };
  const last = new Date(String(lastSeenISO));
  const now = new Date(String(nowISO));
  const gapMs = now.getTime() - last.getTime();
  if (!Number.isFinite(gapMs) || gapMs <= thresholdMs) return { downtime: false, ref: null, hours: 0 };
  const hours = Number((gapMs / 3.6e6).toFixed(1));
  return { downtime: true, ref: `${last.toISOString()}..${now.toISOString()}`, hours };
}

// Обновить heartbeat живого процесса. Зовётся каждым тиком runner'а. Дешёвый upsert.
export async function touchOrchestratorHeartbeat(s) {
  return withClient(clientConfig(s), async (c) => {
    await c.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, to_jsonb(now()::text), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [HEARTBEAT_KEY],
    );
  });
}

// На старте: если с последнего heartbeat прошло больше thresholdMs — оркестратор
// простаивал, ставим метку downtime за интервал [last_seen, now] (идемпотентно по
// ref). Затем инициализируем heartbeat текущим временем. Первый запуск (ключа ещё
// нет) метку не плодит — размечать нечего. Возвращает { downtime, ref, hours }.
export async function recordDowntimeMarker(s, { thresholdMs = 600000 } = {}) {
  return withClient(clientConfig(s), async (c) => {
    const prev = await c.query('SELECT value FROM app_settings WHERE key = $1', [HEARTBEAT_KEY]);
    const now = new Date((await c.query('SELECT now() AS now')).rows[0].now);
    const lastSeen = prev.rowCount && prev.rows[0].value != null ? String(prev.rows[0].value) : null;
    const dt = computeDowntime(lastSeen, now.toISOString(), thresholdMs);
    const touch = () => c.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, to_jsonb($2::text), now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [HEARTBEAT_KEY, now.toISOString()],
    );
    if (dt.downtime) {
      const exists = await c.query(
        `SELECT 1 FROM kpi_markers WHERE marker_type = 'downtime' AND ref = $1 LIMIT 1`, [dt.ref],
      );
      if (!exists.rowCount) {
        await c.query(
          `INSERT INTO kpi_markers (role_id, marker_type, ref, description, created_at)
           VALUES (NULL, 'downtime', $1, $2, $3)`,
          [dt.ref, `Простой оркестратора ~${dt.hours} ч (${new Date(lastSeen).toISOString()} → ${now.toISOString()})`,
           new Date(lastSeen)],
        );
      }
    }
    await touch();
    return dt;
  });
}

async function resolveProjectId(c, projectId) {
  if (projectId == null || String(projectId).trim() === '') return null;
  const ref = String(projectId).trim();
  const pr = await c.query(
    `SELECT id FROM projects WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at LIMIT 1`,
    [ref],
  );
  return pr.rowCount ? pr.rows[0].id : null;
}

function numOrNull(v, digits) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function badRequest(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}
