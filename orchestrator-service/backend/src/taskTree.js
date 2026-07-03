// TASK-TREE-001 — read-only дерево задач для UI «Схемы разработки».
// Трёхуровневое дерево: Проект (категория) → Задача (подкатегория) →
// Подзадача (третий уровень). Источник — tasks (project_id, parent_task_id).
// Подзадача определяется по parent_task_id; уровни глубже третьего
// «подтягиваются» к ближайшей задаче-родителю верхнего уровня, чтобы дерево
// всегда оставалось трёхуровневым. Endpoint ничего не изменяет.
import { withClient, clientConfig } from './db.js';

/**
 * GET /api/tasks/tree — все проекты с их задачами и подзадачами.
 * Возвращает { projects: [{ id, name, code, taskCount,
 *   tasks: [{ id, title, status, priority, subtasks: [...] }] }] }.
 * Проекты без задач включаются (пустой tasks). Один проход по БД (2 запроса).
 */
/**
 * GET /api/tasks/stats — счётчики задач по статусам (по всем проектам). Схема
 * разработки общая, поэтому этап (task_status) считается по всем проектам сразу.
 * Возвращает { byStatus: { CODING: 5, REVIEW: 2, ... }, runningByStatus, total }.
 * runningByStatus — число параллельно работающих процессов (agent_runs в статусе
 * RUNNING), сгруппированных по текущему статусу задачи; без временного окна, чтобы
 * отражать ровно активные запуски на каждом этапе. Read-only.
 */
export async function getTaskStatusCounts(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT status::text AS status, count(*)::int AS n FROM tasks GROUP BY status`,
    );
    const running = await c.query(
      `SELECT t.status::text AS status, count(*)::int AS n
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
        WHERE ar.status = 'RUNNING'
        GROUP BY t.status`,
    );
    const byStatus = {};
    let total = 0;
    for (const row of r.rows) {
      byStatus[row.status] = row.n;
      total += row.n;
    }
    const runningByStatus = {};
    for (const row of running.rows) {
      runningByStatus[row.status] = row.n;
    }
    return { byStatus, runningByStatus, total };
  });
}

/**
 * GET /api/tasks/by-stage?roleId=<uuid> — задачи, прошедшие через конкретный этап
 * схемы, и результат, который этот этап (роль) внёс в каждую задачу.
 *
 * Этап единой схемы = роль (global_stage_roles.role_id) + статус. Факт прохождения
 * и результат берём из agent_runs: каждый запуск роли над задачей сохраняет
 * output_json (для runner-ролей — { status, summary, findings, reason, outcome,
 * fields }, для host-ролей — произвольный output). Группируем запуски по задаче
 * (последний запуск — сверху), чтобы было видно и переработки (rework).
 * Read-only. Возвращает { role: { id, code, name } | null, tasks: [...] }.
 */
export async function getTasksByStage(s, roleId) {
  if (!roleId || typeof roleId !== 'string') {
    return { role: null, tasks: [] };
  }
  return withClient(clientConfig(s), async (c) => {
    const roleRes = await c.query(
      'SELECT id, code, name FROM roles WHERE id = $1',
      [roleId],
    );
    const role = roleRes.rows[0]
      ? { id: roleRes.rows[0].id, code: roleRes.rows[0].code, name: roleRes.rows[0].name }
      : null;
    if (!role) return { role: null, tasks: [] };

    const runsRes = await c.query(
      `SELECT ar.id AS run_id, ar.task_id, ar.status::text AS run_status,
              ar.started_at, ar.finished_at, ar.output_json, ar.error_text,
              ar.token_input, ar.token_output, ar.cost,
              t.title, t.status::text AS task_status,
              p.name AS project_name, p.code AS project_code
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         JOIN projects p ON p.id = t.project_id
        WHERE ar.role_id = $1
        ORDER BY ar.started_at DESC NULLS LAST, ar.id DESC
        LIMIT 500`,
      [roleId],
    );

    // Группируем запуски по задаче, сохраняя порядок (последний запуск — первым).
    const byTask = new Map();
    for (const r of runsRes.rows) {
      if (!byTask.has(r.task_id)) {
        byTask.set(r.task_id, {
          taskId: r.task_id,
          title: r.title,
          taskStatus: r.task_status,
          projectName: r.project_name,
          projectCode: r.project_code ?? null,
          runs: [],
        });
      }
      const startedAt = r.started_at ? new Date(r.started_at).toISOString() : null;
      const finishedAt = r.finished_at ? new Date(r.finished_at).toISOString() : null;
      const durationMs =
        r.started_at && r.finished_at
          ? new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()
          : null;
      byTask.get(r.task_id).runs.push({
        runId: r.run_id,
        status: r.run_status,
        startedAt,
        finishedAt,
        durationMs,
        output: r.output_json ?? null,
        error: r.error_text ?? null,
        tokenInput: Number(r.token_input ?? 0),
        tokenOutput: Number(r.token_output ?? 0),
        cost: Number(r.cost ?? 0),
      });
    }

    return { role, tasks: Array.from(byTask.values()) };
  });
}

/**
 * GET /api/tasks/history?taskId=<uuid> — что сделала КАЖДАЯ роль по конкретной
 * задаче. Источник — task_events (append-only хронология): у каждого перехода
 * есть роль и payload с результатом её работы:
 *   • программист — { source:'scanner', result, changedFiles, fields };
 *   • git-интегратор/pipeline — { host, role, success, output:{ commit, branch, files } };
 *   • AI-роли (ревью/аналитик/...) — { runner, ai, role, verdictStatus, summary, outcome, fields }.
 *
 * role_id события не всегда = роль-исполнитель (часто это СЛЕДУЮЩАЯ роль), поэтому
 * «исполнителя» определяем по payload.role, а для программиста — по наличию
 * result/changedFiles. Read-only. Возвращает { task, events } в порядке времени.
 */
export async function getTaskHistory(s, taskId) {
  if (!taskId || typeof taskId !== 'string') {
    return { task: null, events: [] };
  }
  return withClient(clientConfig(s), async (c) => {
    const taskRes = await c.query(
      `SELECT t.id, t.title, t.status::text AS status, t.data_card,
              p.name AS project_name, p.code AS project_code
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.id = $1`,
      [taskId],
    );
    if (!taskRes.rowCount) return { task: null, events: [] };
    const t = taskRes.rows[0];

    const rolesRes = await c.query('SELECT code, name FROM roles');
    const roleNameByCode = new Map(rolesRes.rows.map((r) => [r.code, r.name]));

    const evRes = await c.query(
      `SELECT e.id, e.event_type::text AS event_type,
              e.from_status::text AS from_status, e.to_status::text AS to_status,
              r.code AS role_code, r.name AS role_name,
              e.payload_json, e.created_at
         FROM task_events e
         LEFT JOIN roles r ON r.id = e.role_id
        WHERE e.task_id = $1
        ORDER BY e.created_at ASC, e.id ASC`,
      [taskId],
    );

    // Определить роль-исполнителя события (а не «следующую» роль из role_id).
    // TASK_CREATED исключаем: событие создания тоже несёт result/changedFiles
    // (исходный запрос сканера), но это не работа программиста.
    const actorOf = (payload, eventType) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      if (typeof p.role === 'string' && p.role) return p.role;
      // Программист пишет result/changedFiles, своей роли в payload не указывает.
      if (eventType !== 'TASK_CREATED' && (p.result !== undefined || p.changedFiles !== undefined)) {
        return 'PROGRAMMER';
      }
      return null;
    };

    const events = evRes.rows.map((row) => {
      const payload = row.payload_json ?? null;
      const actorCode = actorOf(payload, row.event_type);
      return {
        id: row.id,
        eventType: row.event_type,
        fromStatus: row.from_status,
        toStatus: row.to_status,
        // role_id события (часто — следующая роль): отдаём отдельно, для справки.
        nextRoleCode: row.role_code ?? null,
        nextRoleName: row.role_name ?? null,
        actorRoleCode: actorCode,
        actorRoleName: actorCode ? roleNameByCode.get(actorCode) ?? actorCode : null,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        payload,
      };
    });

    return {
      task: {
        id: t.id,
        title: t.title,
        status: t.status,
        projectName: t.project_name,
        projectCode: t.project_code ?? null,
        dataCard: t.data_card ?? null,
      },
      events,
    };
  });
}

export async function getTaskTree(s) {
  return withClient(clientConfig(s), async (c) => {
    const projectsRes = await c.query(
      `SELECT id, name, code FROM projects ORDER BY name`,
    );
    const tasksRes = await c.query(
      `SELECT id, project_id, parent_task_id, title,
              status::text AS status, priority::text AS priority, created_at
         FROM tasks
        ORDER BY created_at`,
    );

    // Узлы задач по id (для связывания родитель → подзадача).
    const nodeById = new Map();
    for (const r of tasksRes.rows) {
      nodeById.set(r.id, {
        id: r.id,
        title: r.title,
        status: r.status,
        priority: r.priority,
        projectId: r.project_id,
        parentId: r.parent_task_id,
        subtasks: [],
      });
    }

    // Поиск задачи-родителя ВЕРХНЕГО уровня (для нормализации к 3 уровням):
    // если родитель сам подзадача — поднимаемся выше, пока не дойдём до
    // задачи без родителя (с защитой от циклов).
    const topLevelAncestor = (node) => {
      let cur = node;
      const seen = new Set();
      while (cur.parentId && nodeById.has(cur.parentId) && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = nodeById.get(cur.parentId);
      }
      return cur;
    };

    const projects = projectsRes.rows.map((p) => ({
      id: p.id,
      name: p.name,
      code: p.code ?? null,
      tasks: [],
    }));
    const projectById = new Map(projects.map((p) => [p.id, p]));

    for (const node of nodeById.values()) {
      const isTopLevel = !node.parentId || !nodeById.has(node.parentId);
      if (isTopLevel) {
        const proj = projectById.get(node.projectId);
        if (proj) proj.tasks.push(stripNode(node));
        continue;
      }
      // Подзадача: цепляем к задаче верхнего уровня (третий уровень дерева).
      const ancestor = topLevelAncestor(node);
      if (ancestor && ancestor.id !== node.id) {
        ancestor.subtasks.push(stripNode(node, /* leaf */ true));
      }
    }

    for (const proj of projects) {
      proj.taskCount = proj.tasks.length;
    }

    return { projects };
  });
}

// Узел без служебных полей (projectId/parentId не нужны клиенту).
function stripNode(node, leaf = false) {
  const out = {
    id: node.id,
    title: node.title,
    status: node.status,
    priority: node.priority,
  };
  if (!leaf) out.subtasks = node.subtasks;
  return out;
}
