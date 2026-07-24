// PROJECT-TASK-MONITOR-001 — read-only статистика задач проекта.
// Источник истины: tasks (статус, created_at) + append-only task_events
// (переходы to_status). Все длительности считаются относительно единого
// серверного generatedAt; время браузера не используется. Этап определяется
// по task_status (а НЕ по тексту/имени агента). Endpoint ничего не изменяет.
import { withClient, clientConfig } from './db.js';

// Соответствие task_status → стабильный stageCode + дефолтное имя этапа.
// stageCode стабилен (машинный), stageName — серверная подпись по умолчанию.
export const STAGE_BY_STATUS = {
  BACKLOG: { stageCode: 'BACKLOG', stageName: 'Бэклог' },
  READY: { stageCode: 'READY', stageName: 'Готова к работе' },
  ARCHITECTURE: { stageCode: 'ARCHITECTURE', stageName: 'Архитектура' },
  DECOMPOSITION: { stageCode: 'DECOMPOSITION', stageName: 'Декомпозиция' },
  CODING: { stageCode: 'CODING', stageName: 'Разработка' },
  TESTING: { stageCode: 'TESTING', stageName: 'Пайплайн и тесты' },
  FAILURE_ANALYSIS: { stageCode: 'FAILURE_ANALYSIS', stageName: 'Анализ сбоя' },
  REVIEW: { stageCode: 'REVIEW', stageName: 'Ревью' },
  COMMIT: { stageCode: 'COMMIT', stageName: 'Коммит' },
  DEPLOY: { stageCode: 'DEPLOY', stageName: 'Деплой' },
  DONE: { stageCode: 'DONE', stageName: 'Завершено' },
  BLOCKED: { stageCode: 'BLOCKED', stageName: 'Заблокировано' },
  FAILED: { stageCode: 'FAILED', stageName: 'Ошибка' },
  CANCELLED: { stageCode: 'CANCELLED', stageName: 'Отменено' },
  WAITING_FOR_CHILDREN: { stageCode: 'WAITING_FOR_CHILDREN', stageName: 'Ожидает подзадачи' },
};

// Терминальные статусы: жизненный цикл завершён, длительности фиксируются.
export const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

export function stageForStatus(status) {
  return STAGE_BY_STATUS[status] ?? { stageCode: status ?? 'UNKNOWN', stageName: status ?? 'Неизвестно' };
}

function toMs(value) {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Время входа в ТЕКУЩИЙ статус: created_at самого позднего события с
 * to_status === status. Повторный вход в этап → последний непрерывный
 * интервал. Если перехода нет (задача в исходном статусе) — null.
 */
export function lastEntryIntoStatus(events, status) {
  let latest = null;
  for (const ev of events) {
    if (ev.toStatus !== status) continue;
    const ms = toMs(ev.createdAt);
    if (ms == null) continue;
    if (latest == null || ms >= latest) latest = ms;
  }
  return latest;
}

/**
 * Чистый расчёт строки статистики одной задачи относительно generatedAtMs.
 * task: { id, title, service, status, createdAt, updatedAt }
 * events: [{ toStatus, createdAt }] (в любом порядке)
 * Возвращает стабильный контракт; недостающие отметки → null + timingState.
 */
export function computeTask(task, events, generatedAtMs) {
  const stage = stageForStatus(task.status);
  const createdMs = toMs(task.createdAt);
  const evs = Array.isArray(events) ? events : [];
  const terminal = TERMINAL_STATUSES.has(task.status);

  // Начало текущего этапа: последний вход в статус, иначе — создание задачи.
  const entryMs = lastEntryIntoStatus(evs, task.status);
  const stageStartedMs = entryMs ?? createdMs;

  let stageDurationMs = null;
  let totalDurationMs = null;
  let completedMs = null;
  let timingState = 'ok';

  if (createdMs == null) {
    timingState = 'missing_created';
  } else if (terminal) {
    completedMs = entryMs; // событие входа в терминальный статус
    if (completedMs == null) {
      timingState = 'missing_completion';
    } else {
      totalDurationMs = completedMs - createdMs;
      stageDurationMs = stageStartedMs == null ? null : completedMs - stageStartedMs;
      timingState = 'completed';
    }
  } else {
    // Активная/заблокированная задача: длительности растут к generatedAt.
    totalDurationMs = generatedAtMs - createdMs;
    stageDurationMs = stageStartedMs == null ? null : generatedAtMs - stageStartedMs;
    timingState = 'active';
  }

  return {
    id: task.id,
    title: task.title,
    service: task.service ?? null,
    status: task.status,
    stageCode: stage.stageCode,
    stageName: stage.stageName,
    createdAt: createdMs == null ? null : new Date(createdMs).toISOString(),
    stageStartedAt: stageStartedMs == null ? null : new Date(stageStartedMs).toISOString(),
    completedAt: completedMs == null ? null : new Date(completedMs).toISOString(),
    stageDurationMs: nonNegative(stageDurationMs),
    totalDurationMs: nonNegative(totalDurationMs),
    timingState,
  };
}

// Защита от отрицательных длительностей при рассинхроне часов/событий.
function nonNegative(ms) {
  if (ms == null) return null;
  return ms < 0 ? 0 : ms;
}

/**
 * Чистый расчёт всей выборки: per-task контракт по списку задач и их событий.
 * Агрегаты считаются вызывающим из БД по всему проекту (а не по странице).
 */
export function computeTaskRows({ tasks, eventsByTask }, generatedAtMs) {
  const list = Array.isArray(tasks) ? tasks : [];
  const map = eventsByTask ?? new Map();
  return list.map((t) => computeTask(t, map.get(t.id) ?? [], generatedAtMs));
}

// --- Наблюдаемость (OBSERVABILITY-BLOCK-KPI-001) ----------------------------
// Причину блокировки и KPI токенов/стоимости раньше нельзя было достать иначе как
// прямым SQL в orchestrator_db (task_events.payload_json + agent_runs). Обогащаем
// строки статистики этими данными, чтобы они шли и в HTTP-эндпоинт, и в MCP
// (orchestrator_get_task_statistics) без изменения их схем. Разбор — чистые
// функции ниже (юнит-тестируемы), сбор данных из БД — в getTaskStatistics.

const nUint = (v) => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : 0;
};

/**
 * KPI задачи из агрегата agent_runs. pg отдаёт bigint как строку, numeric как
 * строку — приводим к числам. tokenFreshInput = свежий ввод без кэша
 * (token_input − cache_read − cache_creation), не отрицательный.
 */
export function normalizeKpi(raw) {
  if (!raw) {
    return {
      tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheCreation: 0,
      tokenFreshInput: 0, cost: 0, turns: 0, runs: 0, failedRuns: 0,
    };
  }
  const tokenInput = nUint(raw.token_input);
  const tokenCacheRead = nUint(raw.token_cache_read);
  const tokenCacheCreation = nUint(raw.token_cache_creation);
  return {
    tokenInput,
    tokenOutput: nUint(raw.token_output),
    tokenCacheRead,
    tokenCacheCreation,
    tokenFreshInput: Math.max(0, tokenInput - tokenCacheRead - tokenCacheCreation),
    cost: Number(raw.cost) || 0,
    turns: nUint(raw.turns),
    runs: nUint(raw.runs),
    failedRuns: nUint(raw.failed_runs),
  };
}

/**
 * Причина блокировки из последнего события с to_status='BLOCKED'.
 * note/error/role уже вытащены из payload_json на SQL-слое. null, если ничего нет.
 */
export function normalizeBlockReason(raw) {
  if (!raw) return null;
  const note = raw.note ?? null;
  const error = raw.error ?? null;
  const role = raw.role ?? null;
  if (note == null && error == null && role == null) return null;
  const atMs = toMs(raw.at);
  return { note, error, role, at: atMs == null ? null : new Date(atMs).toISOString() };
}

/**
 * Обогатить строки статистики (мутирует и возвращает их же):
 *  - blockReason — причина блока (или null);
 *  - kpi — агрегат токенов/стоимости/прогонов;
 *  - docForcedAdvance — документационная ветка была force-продвинута к join
 *    сетью безопасности (advanceStuckDocumentationBranches, reason
 *    documentation_branch_advanced): DONE без реальной работы движка доков.
 */
export function enrichTaskRows(rows, { blockByTask = new Map(), kpiByTask = new Map(), docForcedSet = new Set() } = {}) {
  for (const row of rows) {
    row.blockReason = normalizeBlockReason(blockByTask.get(row.id));
    row.kpi = normalizeKpi(kpiByTask.get(row.id));
    row.docForcedAdvance = docForcedSet.has(row.id);
  }
  return rows;
}

// --- DB-слой ---------------------------------------------------------------

import { httpError } from './httpError.js';

async function resolveProjectId(c, projectId) {
  const ref = String(projectId ?? '').trim();
  if (!ref) throw httpError(422, 'project_id_required');
  // Разрешаем по UUID, коду, папке (root_path) или имени. Папка — основной
  // ключ привязки локального проекта к БД; code — стабильный машинный ключ.
  const r = await c.query(
    `SELECT id FROM projects
      WHERE id::text = $1 OR code = $1 OR root_path = $1 OR name = $1
      ORDER BY created_at LIMIT 1`,
    [ref],
  );
  if (!r.rowCount) throw httpError(404, 'project_not_found');
  return r.rows[0].id;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function clampPagination({ limit, offset } = {}) {
  let lim = Number.parseInt(limit, 10);
  if (!Number.isFinite(lim) || lim <= 0) lim = DEFAULT_LIMIT;
  if (lim > MAX_LIMIT) lim = MAX_LIMIT;
  let off = Number.parseInt(offset, 10);
  if (!Number.isFinite(off) || off < 0) off = 0;
  return { limit: lim, offset: off };
}

/**
 * GET /api/projects/:projectId/task-statistics — задачи только этого проекта.
 * Агрегаты — по всему проекту; таблица — постранично. Один generatedAt на
 * ответ. 404 для неизвестного проекта. Ничего не изменяет.
 */
export async function getTaskStatistics(s, projectId, pagination = {}) {
  const { limit, offset } = clampPagination(pagination);
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    const generatedAt = new Date();
    const generatedAtMs = generatedAt.getTime();

    // Агрегаты по всему проекту (дёшево, без загрузки истории).
    const counts = await c.query(
      `SELECT t.status::text AS status, count(*)::int AS n
         FROM tasks t WHERE t.project_id = $1 GROUP BY t.status`,
      [projectDbId],
    );
    const byStatus = {};
    let total = 0;
    for (const row of counts.rows) {
      byStatus[row.status] = row.n;
      total += row.n;
    }
    const sumByStage = (statuses) =>
      statuses.reduce((acc, st) => acc + (byStatus[st] ?? 0), 0);
    const blocked = byStatus.BLOCKED ?? 0;
    // Отменённые задачи учитываются как завершённые: для пользователя «Отменено»
    // — это закрытый, не требующий действий результат, наравне с «Завершено».
    const completed = (byStatus.DONE ?? 0) + (byStatus.CANCELLED ?? 0);
    const terminalCount = sumByStage([...TERMINAL_STATUSES]);
    const active = total - terminalCount - blocked;
    const byStage = {};
    for (const [status, n] of Object.entries(byStatus)) {
      byStage[stageForStatus(status).stageCode] = n;
    }

    // Средняя длительность завершённых (DONE): completedAt − createdAt.
    const avg = await c.query(
      `SELECT avg(extract(epoch FROM (ev.completed_at - t.created_at)) * 1000) AS avg_ms
         FROM tasks t
         JOIN LATERAL (
           SELECT max(created_at) AS completed_at FROM task_events
            WHERE task_id = t.id AND to_status = 'DONE'
         ) ev ON true
        WHERE t.project_id = $1 AND t.status = 'DONE' AND ev.completed_at IS NOT NULL`,
      [projectDbId],
    );
    const averageCompletedDurationMs =
      avg.rows[0].avg_ms == null ? null : Math.max(0, Math.round(Number(avg.rows[0].avg_ms)));

    // Постраничный список: активные сначала, затем по времени изменения.
    // rank: 0 = активная, 1 = заблокированная, 2 = терминальная.
    const page = await c.query(
      `SELECT t.id, t.title, s.service_code AS service, t.status::text AS status,
              t.created_at, t.updated_at
         FROM tasks t
         LEFT JOIN services s ON s.id = t.service_id
        WHERE t.project_id = $1
        ORDER BY CASE
                   WHEN t.status IN ('DONE','CANCELLED','FAILED') THEN 2
                   WHEN t.status = 'BLOCKED' THEN 1
                   ELSE 0
                 END,
                 t.updated_at DESC, t.created_at DESC
        LIMIT $2 OFFSET $3`,
      [projectDbId, limit, offset],
    );

    const taskRows = page.rows.map((r) => ({
      id: r.id,
      title: r.title,
      service: r.service,
      status: r.status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));

    // События только для задач текущей страницы (без N+1: один запрос).
    const eventsByTask = new Map();
    if (taskRows.length) {
      const ev = await c.query(
        `SELECT task_id, to_status::text AS to_status, created_at
           FROM task_events
          WHERE task_id = ANY($1::uuid[]) AND to_status IS NOT NULL
          ORDER BY created_at`,
        [taskRows.map((t) => t.id)],
      );
      for (const row of ev.rows) {
        const arr = eventsByTask.get(row.task_id) ?? [];
        arr.push({ toStatus: row.to_status, createdAt: row.created_at });
        eventsByTask.set(row.task_id, arr);
      }
    }

    const tasks = computeTaskRows({ tasks: taskRows, eventsByTask }, generatedAtMs);

    // OBSERVABILITY-BLOCK-KPI-001: причина блока (последнее событие BLOCKED),
    // KPI токенов/стоимости из agent_runs и флаг force-продвижения doc-ветки —
    // только для задач текущей страницы (три запроса, без N+1).
    const blockByTask = new Map();
    const kpiByTask = new Map();
    const docForcedSet = new Set();
    if (taskRows.length) {
      const ids = taskRows.map((t) => t.id);
      // Один pg-клиент не выполняет запросы параллельно — идём последовательно
      // (как и остальные запросы этого хендлера).
      const blk = await c.query(
        `SELECT DISTINCT ON (task_id) task_id,
                coalesce(payload_json->'output'->>'note', payload_json->>'note', payload_json->>'reason') AS note,
                left(coalesce(payload_json->'output'->>'error', payload_json->>'error'), 800) AS error,
                payload_json->>'role' AS role, created_at AS at
           FROM task_events
          WHERE task_id = ANY($1::uuid[]) AND to_status = 'BLOCKED'
          ORDER BY task_id, created_at DESC`,
        [ids],
      );
      const kpi = await c.query(
        `SELECT task_id,
                coalesce(sum(token_input),0)::bigint          AS token_input,
                coalesce(sum(token_output),0)::bigint         AS token_output,
                coalesce(sum(token_cache_read),0)::bigint     AS token_cache_read,
                coalesce(sum(token_cache_creation),0)::bigint AS token_cache_creation,
                coalesce(sum(cost),0)::numeric                AS cost,
                coalesce(sum(turns),0)::bigint                AS turns,
                count(*)::int                                 AS runs,
                count(*) FILTER (WHERE status IN ('FAILED','TIMEOUT'))::int AS failed_runs
           FROM agent_runs
          WHERE task_id = ANY($1::uuid[])
          GROUP BY task_id`,
        [ids],
      );
      const doc = await c.query(
        `SELECT DISTINCT task_id FROM task_events
          WHERE task_id = ANY($1::uuid[])
            AND payload_json->>'reason' = 'documentation_branch_advanced'`,
        [ids],
      );
      for (const r of blk.rows) blockByTask.set(r.task_id, r);
      for (const r of kpi.rows) kpiByTask.set(r.task_id, r);
      for (const r of doc.rows) docForcedSet.add(r.task_id);
    }
    enrichTaskRows(tasks, { blockByTask, kpiByTask, docForcedSet });

    return {
      projectId: projectDbId,
      generatedAt: generatedAt.toISOString(),
      summary: {
        total,
        active,
        completed,
        blocked,
        byStage,
        averageCompletedDurationMs,
      },
      pagination: { limit, offset, total },
      tasks,
    };
  });
}
