/**
 * Клиент дерева задач (read-only). Контракт: GET /api/tasks/tree
 * (orchestrator taskTree.js). Трёхуровневое дерево:
 * Проект (категория) → Задача (подкатегория) → Подзадача (третий уровень).
 */
import { http } from './http';

/** Подзадача — лист дерева (третий уровень). */
export interface TaskTreeSubtask {
  id: string;
  title: string;
  status: string;
  priority: string;
}

/** Задача — второй уровень; содержит подзадачи. */
export interface TaskTreeTask extends TaskTreeSubtask {
  subtasks: TaskTreeSubtask[];
}

/** Проект — корневая категория дерева. */
export interface TaskTreeProject {
  id: string;
  name: string;
  code: string | null;
  taskCount: number;
  tasks: TaskTreeTask[];
}

export interface TaskTree {
  projects: TaskTreeProject[];
}

export const tasksApi = {
  /** `GET /api/tasks/tree` — все проекты с задачами и подзадачами. */
  async tree(signal?: AbortSignal): Promise<TaskTree> {
    return http.get<TaskTree>('/api/tasks/tree', { signal });
  },
};
