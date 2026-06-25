import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();

// Реальный ApiError нужен для проверки ветки 409. Объявляем через vi.hoisted,
// чтобы класс был инициализирован до поднятого vi.mock: объявление класса (в
// отличие от const-фабрики vi.fn) не поднимается и иначе попадает в TDZ.
const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    body: unknown;
    constructor(message: string, status: number, body?: unknown) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  }
  return { ApiError };
});

vi.mock('./http', () => ({
  ApiError,
  http: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));

import {
  databaseConnectionsApi,
  DbConnectionInUseError,
  isDraftConnectionId,
} from './databaseConnectionsApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
});

describe('databaseConnectionsApi — единый контракт /api/database-connections', () => {
  it('list читает { connections } (секрет не возвращается, есть hasSecret)', async () => {
    get.mockResolvedValue({
      connections: [
        {
          id: 'uuid-1',
          name: 'Каталог-БД',
          dbmsType: 'postgres',
          host: 'h',
          port: 5432,
          database: 'catalog',
          user: 'app',
          sslMode: 'disable',
          hasSecret: true,
        },
      ],
    });
    const list = await databaseConnectionsApi.list();
    expect(get).toHaveBeenCalledWith('/api/database-connections', { signal: undefined });
    expect(list[0]).toMatchObject({ id: 'uuid-1', hasSecret: true });
    // Не должно быть ключа password или отдельного ключа secret; флаг hasSecret разрешён.
    expect(JSON.stringify(list[0])).not.toMatch(/"(password|secret)"\s*:/i);
  });

  it('create НЕ отправляет пустой пароль и отправляет заданный', async () => {
    post.mockResolvedValue({ id: 'x', name: 'N', dbmsType: 'postgres', host: 'h', port: 1, database: 'd', user: 'u', sslMode: 'disable', hasSecret: false });
    const base = {
      name: 'N',
      dbmsType: 'postgres' as const,
      host: 'h',
      port: 5432,
      database: 'd',
      user: 'u',
      sslMode: 'disable' as const,
    };
    await databaseConnectionsApi.create(base);
    expect((post.mock.calls[0]![1] as Record<string, unknown>).password).toBeUndefined();

    await databaseConnectionsApi.create({ ...base, password: 's3cret' });
    expect((post.mock.calls[1]![1] as Record<string, unknown>).password).toBe('s3cret');
  });

  it('update с пустым паролем не передаёт password (не менять секрет)', async () => {
    put.mockResolvedValue({ id: 'id1', name: 'N', dbmsType: 'postgres', host: 'h', port: 1, database: 'd', user: 'u', sslMode: 'disable', hasSecret: true });
    await databaseConnectionsApi.update('id1', {
      name: 'N',
      dbmsType: 'postgres',
      host: 'h',
      port: 5432,
      database: 'd',
      user: 'u',
      sslMode: 'disable',
      password: '',
    });
    const [path, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/database-connections/id1');
    expect(body.password).toBeUndefined();
  });

  it('test обращается к /:id/test', async () => {
    post.mockResolvedValue({ connected: true, error: null });
    const r = await databaseConnectionsApi.test('id1');
    expect(post).toHaveBeenCalledWith('/api/database-connections/id1/test');
    expect(r).toEqual({ connected: true, error: null });
  });

  it('remove бросает DbConnectionInUseError при 409 с зависимыми проектами', async () => {
    del.mockRejectedValue(
      new ApiError('database_connection_in_use', 409, {
        ok: false,
        code: 'database_connection_in_use',
        count: 2,
        dependents: [
          { id: 'p1', code: 'PS', name: 'ПС' },
          { id: 'p2', code: 'X', name: 'Икс' },
        ],
      }),
    );
    await expect(databaseConnectionsApi.remove('id1')).rejects.toBeInstanceOf(
      DbConnectionInUseError,
    );
    try {
      await databaseConnectionsApi.remove('id1');
    } catch (e) {
      const err = e as DbConnectionInUseError;
      expect(err.count).toBe(2);
      expect(err.dependents).toHaveLength(2);
      expect(err.dependents[0]!.name).toBe('ПС');
    }
  });

  it('remove успешно при 200', async () => {
    del.mockResolvedValue({ deleted: true });
    await expect(databaseConnectionsApi.remove('id1')).resolves.toBeUndefined();
    expect(del).toHaveBeenCalledWith('/api/database-connections/id1');
  });

  it('makeDraft даёт локальный id, распознаваемый isDraftConnectionId', () => {
    const draft = databaseConnectionsApi.makeDraft();
    expect(isDraftConnectionId(draft.id)).toBe(true);
    expect(draft.hasSecret).toBe(false);
    expect(draft.dbmsType).toBe('postgres');
  });
});
