/**
 * Чистая фильтрация дерева задач для раздела «Задачи». Когда выполненные скрыты,
 * убираем задачи и подзадачи в статусе DONE и пересчитываем taskCount проекта,
 * чтобы счётчик соответствовал текущему фильтру. Проекты остаются в дереве даже с
 * нулевым счётчиком (пользователь видит, что проект есть, но активных задач нет).
 */
import type { TaskTree, TaskTreeProject } from '../../api/tasksApi';

export const DONE_STATUS = 'DONE';

function filterProject(project: TaskTreeProject): TaskTreeProject {
  const tasks = project.tasks
    .filter((task) => task.status !== DONE_STATUS)
    .map((task) => ({
      ...task,
      subtasks: task.subtasks.filter((sub) => sub.status !== DONE_STATUS),
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
