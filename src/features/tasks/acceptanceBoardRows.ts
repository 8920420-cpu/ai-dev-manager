/**
 * TASK-ACCEPTANCE-001 — чистый отбор строк доски приёмки для подразделов.
 *
 * Доска (GET /api/tasks/acceptance-board) отдаёт задачи в статусах DONE и
 * CANCELLED. Деление по подразделам:
 *  - «Проверка» (review): только НЕ принятые DONE (ждут приёмки). CANCELLED сюда
 *    не попадают — их не принимают.
 *  - «Выполнено» (done): принятые DONE + все CANCELLED (архив с причиной отмены).
 *    Внутри «Выполнено» доступен фильтр по статусу (все / только DONE / только
 *    CANCELLED) — переключает список без перезагрузки.
 */
import type { AcceptanceTask } from '../../api/tasksApi';
import type { AcceptanceMode } from './AcceptanceBoardPage';

/** Фильтр статуса в подразделе «Выполнено». */
export type DoneStatusFilter = 'all' | 'done' | 'cancelled';

export const DONE_STATUS = 'DONE';
export const CANCELLED_STATUS = 'CANCELLED';

/** Опции дропдауна фильтра «Выполнено» (в порядке отображения). */
export const DONE_FILTER_OPTIONS: { value: DoneStatusFilter; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'done', label: 'Выполнено (DONE)' },
  { value: 'cancelled', label: 'Отменено (CANCELLED)' },
];

/**
 * Отобрать строки доски под текущий подраздел и (для «Выполнено») фильтр статуса.
 * Порядок задач сохраняется — доска уже отсортирована сервером.
 */
export function selectBoardRows(
  board: AcceptanceTask[],
  mode: AcceptanceMode,
  statusFilter: DoneStatusFilter = 'all',
): AcceptanceTask[] {
  if (mode === 'review') {
    // «Проверка» не изменилась: только не принятые DONE. CANCELLED исключены.
    return board.filter((t) => t.status === DONE_STATUS && !t.accepted);
  }
  // «Выполнено»: принятые DONE + все CANCELLED.
  const done = board.filter((t) => t.accepted || t.status === CANCELLED_STATUS);
  if (statusFilter === 'done') return done.filter((t) => t.status === DONE_STATUS);
  if (statusFilter === 'cancelled') return done.filter((t) => t.status === CANCELLED_STATUS);
  return done;
}
