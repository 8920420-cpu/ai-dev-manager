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
