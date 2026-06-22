import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const del = vi.fn();
vi.mock('./http', () => ({
  http: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    del: (...a: unknown[]) => del(...a),
  },
}));

// settingsApi для listSelectable.
const settingsGet = vi.fn();
vi.mock('./settingsApi', () => ({
  settingsApi: { get: () => settingsGet() },
}));

import { databasesApi, PRIMARY_DB_ID } from './databasesApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
  settingsGet.mockReset();
});

describe('databasesApi — доп. БД через REST /api/additional-databases', () => {
  it('list читает контракт без секрета (hasSecret игнорируется в DatabaseConnection)', async () => {
    get.mockResolvedValue({
      databases: [
        {
          id: 'db-uuid-1',
          name: 'Аналитика',
          host: 'h',
          port: 5433,
          database: 'an',
          user: 'u',
          sslMode: 'require',
          hasSecret: true,
        },
      ],
    });
    const list = await databasesApi.list();
    expect(get).toHaveBeenCalledWith('/api/additional-databases', { signal: undefined });
    expect(list[0]).toEqual({
      id: 'db-uuid-1',
      name: 'Аналитика',
      host: 'h',
      port: 5433,
      database: 'an',
      user: 'u',
      sslMode: 'require',
    });
    // Секрет/hasSecret не утекает в модель.
    expect(JSON.stringify(list[0])).not.toContain('hasSecret');
    expect(JSON.stringify(list[0])).not.toContain('secret');
  });

  it('create НЕ отправляет пароль, если он пустой; отправляет, если задан', async () => {
    post.mockResolvedValue({ id: 'x', name: 'N', host: 'h', port: 1, database: 'd', user: 'u', sslMode: 'disable' });
    const draft = databasesApi.make();
    draft.name = 'N';
    draft.host = 'h';
    draft.database = 'd';
    draft.user = 'u';

    await databasesApi.create(draft);
    expect((post.mock.calls[0]![1] as Record<string, unknown>).password).toBeUndefined();

    await databasesApi.create(draft, 'secret123');
    expect((post.mock.calls[1]![1] as Record<string, unknown>).password).toBe('secret123');
  });

  it('update с пустым паролем не передаёт password (не менять секрет)', async () => {
    put.mockResolvedValue({ id: 'id1', name: 'N', host: 'h', port: 1, database: 'd', user: 'u', sslMode: 'disable' });
    const draft = databasesApi.make();
    draft.name = 'N';
    await databasesApi.update('id1', draft, '');
    const [path, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/additional-databases/id1');
    expect(body.password).toBeUndefined();
  });

  it('remove дергает DELETE по id', async () => {
    del.mockResolvedValue({ deleted: true });
    await databasesApi.remove('id1');
    expect(del).toHaveBeenCalledWith('/api/additional-databases/id1');
  });

  it('listSelectable объединяет основную PG и доп. БД', async () => {
    settingsGet.mockResolvedValue({ database: 'orchestrator_db' });
    get.mockResolvedValue({
      databases: [
        { id: 'db-2', name: 'Доп', host: 'h', port: 1, database: 'd', user: 'u', sslMode: 'disable' },
      ],
    });
    const list = await databasesApi.listSelectable();
    expect(list[0]).toMatchObject({ id: PRIMARY_DB_ID, kind: 'primary' });
    expect(list[1]).toMatchObject({ id: 'db-2', kind: 'additional', name: 'Доп' });
  });
});
