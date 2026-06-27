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
  RESTART: 'Перезапуск',
};

/** Подпись статуса с запасным вариантом для неизвестных кодов. */
export function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABEL[status as TaskStatus] ?? status;
}
