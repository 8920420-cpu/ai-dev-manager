import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем http-клиент: проверяем, что advance/move бьют в правильные эндпоинты.
const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('./http', async () => {
  const actual = await vi.importActual<typeof import('./http')>('./http');
  return {
    ApiError: actual.ApiError,
    getApiToken: () => null,
    http: {
      get: (...a: unknown[]) => get(...a),
      post: (...a: unknown[]) => post(...a),
      put: (...a: unknown[]) => put(...a),
      patch: (...a: unknown[]) => patch(...a),
      del: (...a: unknown[]) => del(...a),
    },
  };
});

import { tasksApi } from './tasksApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
});

describe('tasksApi.advance', () => {
  it('POST /api/tasks/:id/advance и возвращает результат', async () => {
    post.mockResolvedValue({ advanced: true, taskId: 'abc', fromStatus: 'CODING', toStatus: 'REVIEW', nextRole: 'TASK_REVIEWER', done: false });
    const res = await tasksApi.advance('abc');
    expect(post).toHaveBeenCalledWith('/api/tasks/abc/advance');
    expect(res.toStatus).toBe('REVIEW');
  });

  it('кодирует taskId в пути', async () => {
    post.mockResolvedValue({ advanced: true });
    await tasksApi.advance('a/b');
    expect(post).toHaveBeenCalledWith('/api/tasks/a%2Fb/advance');
  });
});

describe('tasksApi.move', () => {
  it('POST /api/tasks/:id/move с телом { toStageId, reason }', async () => {
    post.mockResolvedValue({ moved: true, taskId: 't1', fromStatus: 'BLOCKED', toStatus: 'CODING', targetStage: 'Programmer' });
    const res = await tasksApi.move('t1', { toStageId: 's2', reason: 'разблокировка' });
    expect(post).toHaveBeenCalledWith('/api/tasks/t1/move', { toStageId: 's2', reason: 'разблокировка' });
    expect(res.toStatus).toBe('CODING');
  });

  it('reason необязателен', async () => {
    post.mockResolvedValue({ moved: true });
    await tasksApi.move('t1', { toStageId: 's2' });
    expect(post).toHaveBeenCalledWith('/api/tasks/t1/move', { toStageId: 's2', reason: undefined });
  });
});
