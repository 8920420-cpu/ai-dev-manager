/**
 * Справочник статусов задач (зеркало enum `task_status` в БД и
 * TASK_STATUSES в orchestrator-service/backend/src/stages.js).
 * Используется дропдауном статуса Scanner-этапа и мониторингом задач.
 */

/** Машинные коды статусов в порядке жизненного цикла задачи. */
export const TASK_STATUSES = [
  'BACKLOG',
  'READY',
  'ARCHITECTURE',
  'DECOMPOSITION',
  'CODING',
  'TESTING',
  'FAILURE_ANALYSIS',
  'REVIEW',
  'COMMIT',
  'DEPLOY',
  'DONE',
  'BLOCKED',
  'FAILED',
  'CANCELLED',
  'WAITING_FOR_CHILDREN',
  // TASK-NEEDS-INPUT-001 — исполнитель остановился и ждёт ответа ЧЕЛОВЕКА (вопрос и
  // варианты лежат в задаче). Не путать с WAITING_FOR_CHILDREN — тот про fork/join.
  'NEEDS_INPUT',
  'RESTART',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Человекочитаемые подписи статусов (RU). */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  BACKLOG: 'Бэклог',
  READY: 'Готова к работе',
  ARCHITECTURE: 'Архитектура',
  DECOMPOSITION: 'Декомпозиция',
  CODING: 'Разработка',
  TESTING: 'Пайплайн и тесты',
  FAILURE_ANALYSIS: 'Анализ сбоя',
  REVIEW: 'Ревью',
  COMMIT: 'Коммит',
  DEPLOY: 'Деплой',
  DONE: 'Завершено',
  BLOCKED: 'Заблокировано',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
  WAITING_FOR_CHILDREN: 'Ожидает подзадачи',
  NEEDS_INPUT: 'Нужна информация',
  RESTART: 'Перезапуск',
};

/** Подпись статуса с запасным вариантом для неизвестных кодов. */
export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABEL[status as TaskStatus] ?? status;
}

/**
 * Тон бейджа статуса. Раньше эта функция была скопирована в пяти местах
 * (TasksPage, StageTasksModal, TaskChangesModal, TasksTreeModal, ProjectMonitor),
 * и новый статус пришлось бы добавлять в каждое — держим одну копию рядом с
 * подписями. Тон 'warning' у NEEDS_INPUT — сигнал «ждём действия человека»,
 * отдельный от 'danger' (сбой) и 'info' (задача сама едет по конвейеру).
 */
export function taskStatusTone(status: string): TaskStatusTone {
  if (status === 'DONE') return 'success';
  if (status === 'BLOCKED' || status === 'FAILED' || status === 'CANCELLED') return 'danger';
  if (status === 'NEEDS_INPUT' || status === 'RESTART') return 'warning';
  if (status === 'READY' || status === 'BACKLOG') return 'neutral';
  return 'info';
}

/**
 * Тона бейджей (совпадает с BadgeTone из components/ui/Badge). Держим локальный
 * тип, чтобы справочник данных не зависел от слоя компонентов.
 */
export type TaskStatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary';

/** Статусы, из которых задача сама дальше не поедет без человека. */
export function isTaskAwaitingHuman(status: string): boolean {
  return status === 'NEEDS_INPUT';
}
