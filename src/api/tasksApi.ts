/**
 * Клиент дерева задач (read-only). Контракт: GET /api/tasks/tree
 * (orchestrator taskTree.js). Трёхуровневое дерево:
 * Проект (категория) → Задача (подкатегория) → Подзадача (третий уровень).
 */
import { getApiToken, http } from './http';

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

/** Счётчики задач по статусам (этапам) — для бейджей в «Схеме разработки». */
export interface TaskStatusCounts {
  byStatus: Record<string, number>;
  total: number;
}

export interface TaskChangedEvent {
  reason: string;
  generatedAt: string;
  taskId?: string | null;
}

export function subscribeTaskChanges(onChange: (event: TaskChangedEvent) => void): () => void {
  if (typeof EventSource === 'undefined') return () => {};

  const token = getApiToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const source = new EventSource(`/api/tasks/events${query}`);
  source.addEventListener('tasks_changed', (event) => {
    try {
      onChange(JSON.parse((event as MessageEvent).data) as TaskChangedEvent);
    } catch {
      onChange({ reason: 'tasks_changed', generatedAt: new Date().toISOString() });
    }
  });
  return () => source.close();
}

/** Один запуск роли над задачей — результат, который этап внёс в задачу. */
export interface StageTaskRun {
  runId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** Произвольный output роли: { status, summary, findings, reason, outcome, fields } и т.п. */
  output: Record<string, unknown> | null;
  error: string | null;
  tokenInput: number;
  tokenOutput: number;
  cost: number;
}

/** Задача, прошедшая через этап, со всеми запусками роли этого этапа над ней. */
export interface StageTask {
  taskId: string;
  title: string;
  taskStatus: string;
  projectName: string;
  projectCode: string | null;
  runs: StageTaskRun[];
}

/** Ответ `GET /api/tasks/by-stage`: роль этапа + задачи, прошедшие через него. */
export interface StageTasks {
  role: { id: string; code: string; name: string } | null;
  tasks: StageTask[];
}

/** Одно событие хронологии задачи — что сделала роль на этом шаге. */
export interface TaskHistoryEvent {
  id: string;
  eventType: string;
  fromStatus: string | null;
  toStatus: string | null;
  /** Роль из role_id события (часто — следующая роль), для справки. */
  nextRoleCode: string | null;
  nextRoleName: string | null;
  /** Роль-исполнитель (кто реально сделал работу на этом шаге). */
  actorRoleCode: string | null;
  actorRoleName: string | null;
  createdAt: string | null;
  /** Сырой payload события (результат роли). Форма зависит от роли. */
  payload: Record<string, unknown> | null;
}

/** Заголовок задачи в окне хронологии. */
export interface TaskHistoryTask {
  id: string;
  title: string;
  status: string;
  projectName: string;
  projectCode: string | null;
  dataCard: Record<string, unknown> | null;
}

/** Ответ `GET /api/tasks/history`: задача + хронология работы ролей по ней. */
export interface TaskHistory {
  task: TaskHistoryTask | null;
  events: TaskHistoryEvent[];
}

export const tasksApi = {
  /** `GET /api/tasks/tree` — все проекты с задачами и подзадачами. */
  async tree(signal?: AbortSignal): Promise<TaskTree> {
    return http.get<TaskTree>('/api/tasks/tree', { signal });
  },

  /** `GET /api/tasks/stats` — число задач на каждом статусе/этапе (по всем проектам). */
  async stats(signal?: AbortSignal): Promise<TaskStatusCounts> {
    return http.get<TaskStatusCounts>('/api/tasks/stats', { signal });
  },

  /**
   * `GET /api/tasks/by-stage?roleId=…` — задачи, прошедшие через этап (роль), и
   * результат, который этот этап внёс в каждую задачу.
   */
  async byStage(roleId: string, signal?: AbortSignal): Promise<StageTasks> {
    return http.get<StageTasks>(
      `/api/tasks/by-stage?roleId=${encodeURIComponent(roleId)}`,
      { signal },
    );
  },

  /**
   * `GET /api/tasks/history?taskId=…` — хронология задачи: что сделала каждая роль
   * по ней (результат работы каждого этапа).
   */
  async history(taskId: string, signal?: AbortSignal): Promise<TaskHistory> {
    return http.get<TaskHistory>(
      `/api/tasks/history?taskId=${encodeURIComponent(taskId)}`,
      { signal },
    );
  },
};
