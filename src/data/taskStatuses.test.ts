import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  isTaskAwaitingHuman,
  taskStatusLabel,
  taskStatusTone,
} from './taskStatuses';

describe('справочник статусов задач', () => {
  it('у каждого статуса есть человекочитаемая подпись', () => {
    for (const status of TASK_STATUSES) {
      expect(TASK_STATUS_LABEL[status], `нет подписи для ${status}`).toBeTruthy();
    }
  });

  it('неизвестный статус отдаётся как есть, а не пустой строкой', () => {
    expect(taskStatusLabel('WAT')).toBe('WAT');
    expect(taskStatusLabel('CODING')).toBe('Разработка');
  });

  // Список статусов дублируется в трёх местах: enum task_status в БД,
  // TASK_STATUSES в backend/src/stages.js и здесь. Разъезд молча ломает и
  // валидацию Scanner-этапа, и подписи в интерфейсе, поэтому сверяем явно.
  it('совпадает со списком статусов backend (stages.js)', () => {
    const src = readFileSync('orchestrator-service/backend/src/stages.js', 'utf8');
    const block = src.match(/export const TASK_STATUSES = \[([\s\S]*?)\];/);
    expect(block, 'не нашли TASK_STATUSES в stages.js').toBeTruthy();
    const backendStatuses = [...block![1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

    expect([...backendStatuses].sort()).toEqual([...TASK_STATUSES].sort());
  });
});

describe('тон бейджа статуса', () => {
  it('завершение — успех, сбой — опасность, работа — инфо', () => {
    expect(taskStatusTone('DONE')).toBe('success');
    expect(taskStatusTone('FAILED')).toBe('danger');
    expect(taskStatusTone('BLOCKED')).toBe('danger');
    expect(taskStatusTone('CANCELLED')).toBe('danger');
    expect(taskStatusTone('CODING')).toBe('info');
    expect(taskStatusTone('BACKLOG')).toBe('neutral');
  });

  // TASK-NEEDS-INPUT-001: «ждём человека» — это не сбой (danger) и не «едет само»
  // (info), иначе такие задачи теряются в общем списке.
  it('ожидание ответа человека выделено предупреждающим тоном', () => {
    expect(taskStatusTone('NEEDS_INPUT')).toBe('warning');
    expect(TASK_STATUS_LABEL.NEEDS_INPUT).toBe('Нужна информация');
  });

  it('неизвестный статус не роняет функцию', () => {
    expect(taskStatusTone('WAT')).toBe('info');
  });
});

describe('isTaskAwaitingHuman', () => {
  it('истинно только для статуса вопроса к человеку', () => {
    expect(isTaskAwaitingHuman('NEEDS_INPUT')).toBe(true);
    expect(isTaskAwaitingHuman('WAITING_FOR_CHILDREN')).toBe(false);
    expect(isTaskAwaitingHuman('BLOCKED')).toBe(false);
    expect(isTaskAwaitingHuman('CODING')).toBe(false);
  });
});
