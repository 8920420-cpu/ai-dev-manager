/**
 * Чистый выбор строк доски приёмки для подразделов «Проверка»/«Выполнено».
 * Источник — GET /api/tasks/acceptance-board, где наряду с принятыми DONE-задачами
 * приходят и отменённые (CANCELLED).
 *
 * - «Проверка» (mode='review'): только DONE, ещё не принятые. CANCELLED сюда НЕ
 *   попадают — поведение подраздела не меняется.
 * - «Выполнено» (mode='done'): принятые DONE + все CANCELLED. Дополнительно строки
 *   фильтруются клиентски по статусу (statusFilter) — без перезагрузки страницы.
 *
 * Вынесено в отдельный модуль как чистая функция, чтобы покрыть логику vitest-ом
 * без монтирования React-компонента.
 */
import type { AcceptanceTask } from '../../api/tasksApi';

/** Режим доски (совместим с AcceptanceMode из AcceptanceBoardPage). */
export type AcceptanceMode = 'review' | 'done';

/** Значения фильтра по статусу в подразделе «Выполнено». */
export type AcceptanceStatusFilter = 'all' | 'DONE' | 'CANCELLED';

/**
 * Выбрать строки доски под режим и (для «Выполнено») фильтр по статусу.
 * В режиме 'review' параметр statusFilter игнорируется.
 */
export function selectAcceptanceRows(
  board: AcceptanceTask[],
  mode: AcceptanceMode,
  statusFilter: AcceptanceStatusFilter = 'all',
): AcceptanceTask[] {
  if (mode === 'review') {
    // Только не принятые DONE; отменённые исключаем, чтобы «Проверка» не менялась.
    return board.filter((t) => t.status === 'DONE' && !t.accepted);
  }

  // «Выполнено»: принятые (DONE) + все отменённые (CANCELLED).
  const done = board.filter((t) => t.status === 'CANCELLED' || t.accepted);
  if (statusFilter === 'DONE') return done.filter((t) => t.status === 'DONE');
  if (statusFilter === 'CANCELLED') return done.filter((t) => t.status === 'CANCELLED');
  return done;
}
