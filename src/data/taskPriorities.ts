/**
 * Справочник приоритетов задач (зеркало колонки `tasks.priority` в БД).
 * Шкала (значение приходит строкой '0'..'3', см. tasksApi):
 *   0 — задачи проекта оркестратора; выставляется/форсится СЕРВЕРОМ, всегда выше 1,
 *       клиент не может задать/снять его вручную (только чтение);
 *   1 — высокий пользовательский приоритет;
 *   2 — обычный (дефолт);
 *   3 — низкий.
 */
import type { BadgeTone } from '../components/ui';

/** Значение приоритета оркестратора — задаётся только сервером, read-only в UI. */
export const ORCHESTRATOR_PRIORITY = '0';

/** Приоритеты, доступные пользователю для выбора (0 форсится сервером). */
export const SELECTABLE_PRIORITIES = ['1', '2', '3'] as const;

/** Человекочитаемые подписи приоритетов (RU). */
export const TASK_PRIORITY_LABEL: Record<string, string> = {
  '0': 'Оркестратор',
  '1': 'Высокий',
  '2': 'Обычный',
  '3': 'Низкий',
};

/** Подпись приоритета с запасным вариантом для неизвестных значений. */
export function taskPriorityLabel(priority: string): string {
  return TASK_PRIORITY_LABEL[priority] ?? `Приоритет ${priority}`;
}

/** Тон бейджа приоритета. */
export function taskPriorityTone(priority: string): BadgeTone {
  switch (priority) {
    case '0':
      return 'primary';
    case '1':
      return 'danger';
    case '3':
      return 'info';
    default:
      // 2 (обычный) и неизвестные значения — нейтральный тон.
      return 'neutral';
  }
}

/** Приоритет 0 зарезервирован за проектом оркестратора и недоступен для смены. */
export function isOrchestratorPriority(priority: string): boolean {
  return priority === ORCHESTRATOR_PRIORITY;
}
