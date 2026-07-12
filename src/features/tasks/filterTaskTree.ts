/**
 * Чистая фильтрация дерева задач для раздела «Задачи». Когда выполненные скрыты,
 * убираем задачи и подзадачи в терминальных статусах (DONE/CANCELLED/FAILED) и
 * пересчитываем taskCount проекта, чтобы счётчик соответствовал текущему фильтру.
 * Проекты остаются в дереве даже с нулевым счётчиком (пользователь видит, что
 * проект есть, но активных задач нет).
 */
import type { TaskTree, TaskTreeProject } from '../../api/tasksApi';

export const DONE_STATUS = 'DONE';

// Терминальные статусы: задача из них сама не двигается и активной работой уже не
// является, поэтому в разделе «В работе» они по умолчанию скрыты (DONE-задачи живут
// в подразделах «Проверка»/«Выполнено», отменённые/провальные — уже закрыты).
// BLOCKED намеренно НЕ входит: заблокированные требуют ручного вмешательства и
// должны оставаться на виду, чтобы их вернуть в маршрут.
export const HIDDEN_IN_PROGRESS_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

function filterProject(project: TaskTreeProject): TaskTreeProject {
  const tasks = project.tasks
    .filter((task) => !HIDDEN_IN_PROGRESS_STATUSES.has(task.status))
    .map((task) => ({
      ...task,
      subtasks: task.subtasks.filter((sub) => !HIDDEN_IN_PROGRESS_STATUSES.has(sub.status)),
    }));
  return { ...project, tasks, taskCount: tasks.length };
}

export function filterTaskTree(tree: TaskTree, showDone: boolean): TaskTree {
  if (showDone) return tree;
  return { projects: tree.projects.map(filterProject) };
}

/** Суммарное число задач верхнего уровня по дереву (после фильтра). */
export function countTopLevelTasks(tree: TaskTree): number {
  return tree.projects.reduce((acc, p) => acc + p.taskCount, 0);
}

/**
 * Число задач и подзадач с непогашенным документационным долгом (docsDebt != null)
 * по дереву. Индикатор для последующей доработки документации.
 */
export function countDocsDebt(tree: TaskTree): number {
  let count = 0;
  for (const project of tree.projects) {
    for (const task of project.tasks) {
      if (task.docsDebt) count += 1;
      for (const sub of task.subtasks) {
        if (sub.docsDebt) count += 1;
      }
    }
  }
  return count;
}
