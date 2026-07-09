import { describe, it, expect } from 'vitest';
import type { AcceptanceTask } from '../../api/tasksApi';
import { selectBoardRows } from './acceptanceBoardRows';

/** Заготовка задачи доски с переопределяемыми полями. */
function task(over: Partial<AcceptanceTask>): AcceptanceTask {
  return {
    id: 'id',
    status: 'DONE',
    title: 'Задача',
    priority: '2',
    projectId: 'p1',
    projectName: 'Проект',
    serviceName: null,
    accepted: false,
    acceptedAt: null,
    updatedAt: null,
    cancelReason: null,
    duplicateOf: null,
    ...over,
  };
}

const doneReview = task({ id: 'done-review', status: 'DONE', accepted: false });
const doneAccepted = task({ id: 'done-accepted', status: 'DONE', accepted: true, acceptedAt: '2026-07-01T00:00:00Z' });
const cancelledDup = task({
  id: 'cancel-dup', status: 'CANCELLED', accepted: false,
  cancelReason: 'Дубль живой задачи orig', duplicateOf: 'orig',
});
const cancelledPlain = task({
  id: 'cancel-plain', status: 'CANCELLED', accepted: false,
  cancelReason: 'Больше не актуальна',
});

const board = [doneReview, doneAccepted, cancelledDup, cancelledPlain];

describe('selectBoardRows — подраздел «Проверка» (review)', () => {
  it('показывает только не принятые DONE, CANCELLED исключены', () => {
    const rows = selectBoardRows(board, 'review');
    expect(rows.map((t) => t.id)).toEqual(['done-review']);
  });
});

describe('selectBoardRows — подраздел «Выполнено» (done)', () => {
  it('по умолчанию (all) — принятые DONE и все CANCELLED', () => {
    const rows = selectBoardRows(board, 'done');
    expect(rows.map((t) => t.id)).toEqual(['done-accepted', 'cancel-dup', 'cancel-plain']);
  });

  it('фильтр done — только принятые DONE', () => {
    const rows = selectBoardRows(board, 'done', 'done');
    expect(rows.map((t) => t.id)).toEqual(['done-accepted']);
  });

  it('фильтр cancelled — только CANCELLED, с причинами отмены', () => {
    const rows = selectBoardRows(board, 'done', 'cancelled');
    expect(rows.map((t) => t.id)).toEqual(['cancel-dup', 'cancel-plain']);
    expect(rows.every((t) => t.cancelReason)).toBe(true);
    expect(rows[0].duplicateOf).toBe('orig');
  });

  it('переключение фильтра не мутирует исходный список', () => {
    const before = board.map((t) => t.id);
    selectBoardRows(board, 'done', 'cancelled');
    expect(board.map((t) => t.id)).toEqual(before);
  });
});
