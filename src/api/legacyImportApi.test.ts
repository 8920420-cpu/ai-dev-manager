import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
vi.mock('./http', () => ({
  http: {
    post: (...a: unknown[]) => post(...a),
    get: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
}));

import {
  legacyImportApi,
  buildPayload,
  hasLegacyData,
  isImportDone,
  MIGRATION_KEY,
} from './legacyImportApi';

function seedLegacy() {
  localStorage.setItem(
    'adm.projects',
    JSON.stringify([
      {
        id: 'proj_1',
        name: 'Проект',
        path: 'C:/p',
        status: 'active',
        roles: [{ id: 'r1', name: 'Programmer', code: 'PROGRAMMER' }],
        stages: [
          { id: 's1', name: 'Код', enabled: true, roleIds: ['r1'] },
          { id: 's2', name: 'Скан', enabled: true, roleIds: ['r1'], scanPath: 'C:/w' },
        ],
        databaseId: 'primary-postgres',
      },
    ]),
  );
  localStorage.setItem(
    'adm.databases',
    JSON.stringify([
      { id: 'db_1', name: 'Доп', host: 'h', port: 5432, database: 'd', user: 'u', sslMode: 'disable' },
    ]),
  );
  localStorage.setItem(
    'adm.roleConnections',
    JSON.stringify([{ id: 'rc1', role: 'Programmer', integrationId: 'int-1' }]),
  );
}

beforeEach(() => {
  localStorage.clear();
  post.mockReset();
  post.mockResolvedValue({
    migrationKey: MIGRATION_KEY,
    dryRun: false,
    created: { projects: 1, additionalDatabases: 1, roleConnectors: 1 },
    conflicts: [],
    skipped: [],
  });
});

describe('legacyImportApi — сбор payload из localStorage', () => {
  it('hasLegacyData отражает наличие старых ключей', () => {
    expect(hasLegacyData()).toBe(false);
    seedLegacy();
    expect(hasLegacyData()).toBe(true);
  });

  it('payload содержит migrationKey, преобразованные stages (roleCodes) и roleConnectors (roleCode), без секретов', () => {
    seedLegacy();
    const payload = buildPayload(true);
    expect(payload.migrationKey).toBe(MIGRATION_KEY);
    expect(payload.dryRun).toBe(true);

    const project = payload.projects[0] as Record<string, unknown>;
    const stages = project.stages as Array<Record<string, unknown>>;
    expect(stages[0]!.roleCodes).toEqual(['PROGRAMMER']);
    expect((stages[1]!.scanner as { watchDirectory: string }).watchDirectory).toBe('C:/w');

    // Доп. БД — без пароля/секрета.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('secret');

    // roleConnector: имя «Programmer» восстановлено в код PROGRAMMER.
    expect(payload.roleConnectors[0]).toEqual({
      roleCode: 'PROGRAMMER',
      connectorId: 'int-1',
    });
  });
});

describe('legacyImportApi — предпросмотр → коммит и идемпотентность', () => {
  it('preview шлёт dryRun:true и ничего не помечает', async () => {
    seedLegacy();
    post.mockResolvedValueOnce({
      migrationKey: MIGRATION_KEY,
      dryRun: true,
      created: { projects: 1 },
      conflicts: [],
      skipped: [],
    });
    await legacyImportApi.preview();
    const [path, body] = post.mock.calls[0]! as [string, { dryRun: boolean }];
    expect(path).toBe('/api/import/legacy');
    expect(body.dryRun).toBe(true);
    expect(isImportDone()).toBe(false);
  });

  it('commit шлёт dryRun:false и помечает импорт завершённым', async () => {
    seedLegacy();
    await legacyImportApi.commit();
    const [, body] = post.mock.calls[0]! as [string, { dryRun: boolean }];
    expect(body.dryRun).toBe(false);
    expect(isImportDone()).toBe(true);
  });

  it('повторный commit использует тот же migrationKey (идемпотентность по ключу)', async () => {
    seedLegacy();
    await legacyImportApi.commit();
    await legacyImportApi.commit();
    const keys = post.mock.calls.map((c) => (c[1] as { migrationKey: string }).migrationKey);
    expect(keys).toEqual([MIGRATION_KEY, MIGRATION_KEY]);
  });
});
