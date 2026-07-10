import { describe, it, expect } from 'vitest';
import type { AcceptanceTask } from '../../api/tasksApi';
import { selectAcceptanceRows } from './acceptanceRows';

/** Фабрика задачи доски приёмки с разумными значениями по умолчанию. */
function task(over: Partial<AcceptanceTask> & { id: string }): AcceptanceTask {
  return {
    title: `Задача ${over.id}`,
    status: 'DONE',
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

const board: AcceptanceTask[] = [
  task({ id: 'r1', status: 'DONE', accepted: false }), // ждёт приёмки → «Проверка»
  task({ id: 'd1', status: 'DONE', accepted: true }), // принята → «Выполнено»
  task({ id: 'd2', status: 'DONE', accepted: true }), // принята → «Выполнено»
  task({ id: 'c1', status: 'CANCELLED', accepted: false, cancelReason: 'дубликат' }),
  task({ id: 'c2', status: 'CANCELLED', accepted: false, cancelReason: 'не актуально' }),
];

describe('selectAcceptanceRows', () => {
  it('«Проверка»: только не принятые DONE, CANCELLED не попадает', () => {
    const rows = selectAcceptanceRows(board, 'review');
    expect(rows.map((t) => t.id)).toEqual(['r1']);
    expect(rows.every((t) => t.status === 'DONE')).toBe(true);
  });

  it('«Выполнено» (all): принятые DONE + все CANCELLED', () => {
    const rows = selectAcceptanceRows(board, 'done', 'all');
    expect(rows.map((t) => t.id)).toEqual(['d1', 'd2', 'c1', 'c2']);
  });

  it('«Выполнено» без явного statusFilter эквивалентно «all»', () => {
    expect(selectAcceptanceRows(board, 'done')).toEqual(
      selectAcceptanceRows(board, 'done', 'all'),
    );
  });

  it('«Выполнено» (DONE): только принятые DONE', () => {
    const rows = selectAcceptanceRows(board, 'done', 'DONE');
    expect(rows.map((t) => t.id)).toEqual(['d1', 'd2']);
    expect(rows.every((t) => t.status === 'DONE')).toBe(true);
  });

  it('«Выполнено» (CANCELLED): только отменённые', () => {
    const rows = selectAcceptanceRows(board, 'done', 'CANCELLED');
    expect(rows.map((t) => t.id)).toEqual(['c1', 'c2']);
    expect(rows.every((t) => t.status === 'CANCELLED')).toBe(true);
  });

  it('счётчик соответствует длине отфильтрованного списка', () => {
    expect(selectAcceptanceRows(board, 'done', 'all')).toHaveLength(4);
    expect(selectAcceptanceRows(board, 'done', 'DONE')).toHaveLength(2);
    expect(selectAcceptanceRows(board, 'done', 'CANCELLED')).toHaveLength(2);
    expect(selectAcceptanceRows(board, 'review')).toHaveLength(1);
  });
});
