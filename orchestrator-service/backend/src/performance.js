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

    let projectDbId = null;
    if (projectId != null && String(projectId).trim() !== '') {
      const ref = String(projectId).trim();
      const pr = await c.query(
        `SELECT id FROM projects
          WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
          ORDER BY created_at LIMIT 1`,
        [ref],
      );
      if (pr.rowCount) projectDbId = pr.rows[0].id;
    }
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

    // 6) Нагрузка по ролям за 24 часа (agent_runs — учёт исполнения).
    const roleRows = await c.query(
      `SELECT r.code AS role_code, r.name AS role_name,
              count(*)::int AS runs,
              count(*) FILTER (WHERE ar.status = 'SUCCESS')::int AS success,
              count(*) FILTER (WHERE ar.status = 'FAILED')::int AS failed,
              count(*) FILTER (WHERE ar.status = 'TIMEOUT')::int AS timeout,
              count(*) FILTER (WHERE ar.status = 'RUNNING')::int AS running,
              avg(extract(epoch FROM (ar.finished_at - ar.started_at)) * 1000)
                FILTER (WHERE ar.finished_at IS NOT NULL) AS avg_ms
         FROM agent_runs ar
         JOIN roles r ON r.id = ar.role_id
        WHERE ar.started_at >= now() - interval '24 hours'
        GROUP BY r.code, r.name
        ORDER BY runs DESC`,
    );
    const roleLoad = roleRows.rows.map((row) => ({
      roleCode: row.role_code,
      roleName: row.role_name,
      runs: row.runs,
      success: row.success,
      failed: row.failed,
      timeout: row.timeout,
      running: row.running,
      avgDurationMs: row.avg_ms == null ? null : Math.round(Number(row.avg_ms)),
    }));

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
      roleLoad,
      connector: connectorBuckets(),
    };
  });
}

// Признак терминального статуса (экспорт для согласованности с taskStats).
export function isTerminal(status) {
  return TERMINAL.has(status);
}
