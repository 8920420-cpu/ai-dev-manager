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
import { ApiError } from './http';

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

  it('reason передаётся в теле как обязательное поле', async () => {
    post.mockResolvedValue({ moved: true });
    await tasksApi.move('t1', { toStageId: 's2', reason: 'причина' });
    expect(post).toHaveBeenCalledWith('/api/tasks/t1/move', { toStageId: 's2', reason: 'причина' });
  });

  it('кодирует taskId в пути', async () => {
    post.mockResolvedValue({ moved: true });
    await tasksApi.move('a/b', { toStageId: 's2', reason: 'r' });
    expect(post).toHaveBeenCalledWith('/api/tasks/a%2Fb/move', { toStageId: 's2', reason: 'r' });
  });
});

describe('tasksApi — обработка ошибочных ответов', () => {
  it('advance пробрасывает ApiError при ошибке сервера', async () => {
    const err = new ApiError('Нельзя продвинуть терминальную задачу', 409, { error: 'terminal' });
    post.mockRejectedValue(err);
    await expect(tasksApi.advance('abc')).rejects.toBe(err);
    await expect(tasksApi.advance('abc')).rejects.toMatchObject({ status: 409 });
  });

  it('move пробрасывает ApiError при ошибке сервера', async () => {
    const err = new ApiError('Этап не найден', 404, { error: 'not_found' });
    post.mockRejectedValue(err);
    await expect(tasksApi.move('t1', { toStageId: 's2', reason: 'r' })).rejects.toBe(err);
    await expect(tasksApi.move('t1', { toStageId: 's2', reason: 'r' })).rejects.toMatchObject({ status: 404 });
  });
});
