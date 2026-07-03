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
  /**
   * Число параллельно работающих процессов (agent_runs в статусе RUNNING),
   * сгруппированное по текущему статусу задачи. Для счётчика активных процессов
   * рядом со счётчиком задач на карточке этапа.
   */
  runningByStatus: Record<string, number>;
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

/** Неразобранная задача — без проекта (project_id IS NULL), ждёт назначения. */
export interface UnassignedTask {
  id: string;
  externalId: string | null;
  title: string;
  description: string | null;
  status: string;
  createdAt: string | null;
  /** Что постановщик прислал в качестве проекта (не сопоставилось). */
  requestedProject: string | null;
}

/** Ответ `GET /api/tasks/unassigned`. */
export interface UnassignedTasks {
  tasks: UnassignedTask[];
}

/** Ответ `POST /api/tasks/:id/assign-project`. */
export interface AssignProjectResult {
  assigned: boolean;
  taskId: string;
  project: string;
  nextRole: string;
}

/** Ответ `POST /api/tasks/:id/advance` — авто-продвижение по маршруту проекта. */
export interface AdvanceTaskResult {
  advanced: boolean;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  nextRole: string | null;
  done: boolean;
}

/** Ответ `POST /api/tasks/:id/move` — ручное перемещение на выбранный этап. */
export interface MoveTaskResult {
  moved: boolean;
  taskId: string;
  fromStatus: string;
  toStatus: string;
  targetStage: string | null;
}

/** Ответ `POST /api/tasks/restart-stuck` — массовый перезапуск зависших задач. */
export interface RestartStuckResult {
  restarted: number;
}

/** Завершённая конвейером задача (status=DONE) на доске приёмки. */
export interface AcceptanceTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  projectId: string;
  projectName: string;
  serviceName: string | null;
  /** Принята человеком (true) → «Выполнено»; иначе ждёт приёма в «Проверке». */
  accepted: boolean;
  acceptedAt: string | null;
  updatedAt: string | null;
}

/** Ответ `GET /api/tasks/acceptance-board`. */
export interface AcceptanceBoard {
  tasks: AcceptanceTask[];
}

/** Ответ `POST /api/tasks/:id/accept`. */
export interface AcceptTaskResult {
  accepted: boolean;
  taskId: string;
}

export const tasksApi = {
  /** `GET /api/tasks/tree` — все проекты с задачами и подзадачами. */
  async tree(signal?: AbortSignal): Promise<TaskTree> {
    return http.get<TaskTree>('/api/tasks/tree', { signal });
  },

  /**
   * `GET /api/tasks/unassigned` — неразобранные задачи (без проекта). Корзина
   * роли Task Intake Officer: их можно назначить на проект вручную.
   */
  async unassigned(signal?: AbortSignal): Promise<UnassignedTasks> {
    return http.get<UnassignedTasks>('/api/tasks/unassigned', { signal });
  },

  /**
   * `POST /api/tasks/:id/assign-project` — назначить неразобранной задаче проект.
   * После назначения задача уходит по цепочке ролей (исчезает из неразобранных).
   */
  async assignProject(taskId: string, projectId: string): Promise<AssignProjectResult> {
    return http.post<AssignProjectResult>(
      `/api/tasks/${encodeURIComponent(taskId)}/assign-project`,
      { project: projectId },
    );
  },

  /**
   * `POST /api/tasks/:id/advance` — продвинуть задачу на следующий этап маршрута
   * проекта (авто). Недоступно для терминальных/заблокированных задач — для них move().
   */
  async advance(taskId: string): Promise<AdvanceTaskResult> {
    return http.post<AdvanceTaskResult>(`/api/tasks/${encodeURIComponent(taskId)}/advance`);
  },

  /**
   * `POST /api/tasks/:id/move` — ручное перемещение задачи на выбранный этап проекта
   * (manual). Пишет audit-событие; используется для BLOCKED/непродвигаемых задач.
   * Причина (`reason`) обязательна — она попадает в payload события task_events.
   */
  async move(taskId: string, input: { toStageId: string; reason: string }): Promise<MoveTaskResult> {
    return http.post<MoveTaskResult>(`/api/tasks/${encodeURIComponent(taskId)}/move`, input);
  },

  /**
   * `POST /api/tasks/restart-stuck` — перезапустить все зависшие задачи (с проектом,
   * не терминальные, не ждущие подзадачи, не в работе). Они получают статус RESTART
   * и сразу берутся Приёмщиком задач (TASK_INTAKE_OFFICER). Возвращает число задач.
   */
  async restartStuck(): Promise<RestartStuckResult> {
    return http.post<RestartStuckResult>('/api/tasks/restart-stuck');
  },

  /** `GET /api/tasks/stats` — число задач на каждом статусе/этапе (по всем проектам). */
  async stats(signal?: AbortSignal): Promise<TaskStatusCounts> {
    return http.get<TaskStatusCounts>('/api/tasks/stats', { signal });
  },

  /**
   * `GET /api/tasks/acceptance-board` — завершённые конвейером задачи (DONE) для
   * подразделов «Проверка» (не приняты) и «Выполнено» (приняты).
   */
  async acceptanceBoard(signal?: AbortSignal): Promise<AcceptanceBoard> {
    return http.get<AcceptanceBoard>('/api/tasks/acceptance-board', { signal });
  },

  /**
   * `POST /api/tasks/:id/accept` — принять задачу из «Проверки»: она переходит
   * в «Выполнено» (accepted_at). Доступно только для задач в статусе DONE.
   */
  async accept(taskId: string): Promise<AcceptTaskResult> {
    return http.post<AcceptTaskResult>(`/api/tasks/${encodeURIComponent(taskId)}/accept`);
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
