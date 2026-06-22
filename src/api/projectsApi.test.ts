import { describe, it, expect, vi, beforeEach } from 'vitest';

// Мокаем http-клиент; ApiError берём реальный (нужен для ветки 409).
const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
const patch = vi.fn();
const del = vi.fn();
vi.mock('./http', async () => {
  const actual = await vi.importActual<typeof import('./http')>('./http');
  return {
    ApiError: actual.ApiError,
    http: {
      get: (...a: unknown[]) => get(...a),
      post: (...a: unknown[]) => post(...a),
      put: (...a: unknown[]) => put(...a),
      patch: (...a: unknown[]) => patch(...a),
      del: (...a: unknown[]) => del(...a),
    },
  };
});

import { projectsApi, ProjectConflictError, PROJECTS_CHANGED_EVENT } from './projectsApi';
import { ApiError } from './http';
import type { CreateProjectInput } from '../types/project';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  patch.mockReset();
  del.mockReset();
});

describe('projectsApi.list — маппинг RichProject → Project', () => {
  it('маппит path/status/databaseId/stages(scanPath)/roles и сортирует по updatedAt', async () => {
    get.mockResolvedValue({
      projects: [
        {
          id: 'uuid-1',
          name: 'Старый',
          path: 'C:/a',
          status: 'paused',
          databaseId: null,
          stages: [],
          roles: [],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 'uuid-2',
          name: 'Новый',
          path: 'C:/b',
          status: 'active',
          databaseId: 'primary-postgres',
          stages: [
            {
              id: 'st-1',
              name: 'Scanner',
              enabled: true,
              roleIds: ['glob-uuid-scanner'],
              roleCodes: ['SCANNER'],
              scanner: { watchDirectory: 'C:/watch' },
            },
          ],
          roles: [{ id: 'glob-uuid-scanner', code: 'SCANNER', name: 'Scanner' }],
          createdAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
      ],
    });

    const list = await projectsApi.list();
    expect(get).toHaveBeenCalledWith('/api/projects');
    // Сортировка по убыванию updatedAt: «Новый» первым.
    expect(list.map((p) => p.name)).toEqual(['Новый', 'Старый']);
    const fresh = list[0]!;
    expect(fresh.path).toBe('C:/b');
    expect(fresh.databaseId).toBe('primary-postgres');
    expect(fresh.stages[0]!.scanPath).toBe('C:/watch');
    expect(fresh.stages[0]!.roleIds).toEqual(['glob-uuid-scanner']);
    expect(fresh.roles[0]!.code).toBe('SCANNER');
  });
});

describe('projectsApi.create — преобразование этапов и отсутствие proj_*', () => {
  it('шлёт stages с roleCodes (через input.roles), не отправляет локальные id/proj_*', async () => {
    post.mockResolvedValue({
      id: 'srv-uuid',
      name: 'Проект',
      path: 'C:/p',
      status: 'active',
      stages: [],
      roles: [],
      createdAt: 'x',
      updatedAt: 'y',
    });

    const input: CreateProjectInput = {
      name: '  Проект  ',
      path: '  C:/p  ',
      roles: [
        { id: 'role_local_1', name: 'Programmer', code: 'PROGRAMMER' },
        { id: 'role_local_2', name: 'Scanner', code: 'SCANNER' },
      ],
      stages: [
        { id: 'stage_local_1', name: 'Кодинг', enabled: true, roleIds: ['role_local_1'] },
        {
          id: 'stage_local_2',
          name: 'Скан',
          enabled: true,
          roleIds: ['role_local_2'],
          scanPath: 'C:/w',
        },
      ],
      databaseId: 'primary-postgres',
    };

    const created = await projectsApi.create(input);
    expect(created.id).toBe('srv-uuid');

    const [path, body] = post.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/projects');
    expect(body.name).toBe('Проект'); // trim
    expect(body.path).toBe('C:/p');
    expect(body.databaseId).toBe('primary-postgres');

    const stages = body.stages as Array<Record<string, unknown>>;
    expect(stages).toHaveLength(2);
    // Локальные stage_/role_ id НЕ уходят на сервер.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('proj_');
    expect(serialized).not.toContain('stage_local');
    expect(serialized).not.toContain('role_local');
    // roleIds преобразованы в roleCodes.
    expect(stages[0]!.roleCodes).toEqual(['PROGRAMMER']);
    expect(stages[1]!.roleCodes).toEqual(['SCANNER']);
    expect((stages[1]!.scanner as { watchDirectory: string }).watchDirectory).toBe('C:/w');
  });

  it('диспатчит событие PROJECTS_CHANGED_EVENT', async () => {
    post.mockResolvedValue({ id: 'x', name: 'n', path: 'p', stages: [], roles: [] });
    const handler = vi.fn();
    window.addEventListener(PROJECTS_CHANGED_EVENT, handler);
    await projectsApi.create({ name: 'n', path: 'p', roles: [], stages: [] });
    expect(handler).toHaveBeenCalled();
    window.removeEventListener(PROJECTS_CHANGED_EVENT, handler);
  });
});

describe('projectsApi.update — optimistic concurrency и 409', () => {
  it('шлёт updatedAt в теле PUT', async () => {
    put.mockResolvedValue({ id: 'id1', name: 'n', path: 'p', stages: [], roles: [] });
    await projectsApi.update('id1', {
      name: 'Имя',
      updatedAt: '2026-03-03T00:00:00.000Z',
    });
    const [path, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/projects/id1');
    expect(body.updatedAt).toBe('2026-03-03T00:00:00.000Z');
    expect(body.name).toBe('Имя');
  });

  it('бросает ProjectConflictError при HTTP 409', async () => {
    put.mockRejectedValue(new ApiError('project_conflict', 409));
    await expect(
      projectsApi.update('id1', { name: 'x', updatedAt: 'stale' }),
    ).rejects.toBeInstanceOf(ProjectConflictError);
  });
});

describe('projectsApi.setStatus — PATCH', () => {
  it('шлёт PATCH /status с {status}', async () => {
    patch.mockResolvedValue({ id: 'id1', name: 'n', path: 'p', status: 'archived', stages: [], roles: [] });
    const res = await projectsApi.setStatus('id1', 'archived');
    const [path, body] = patch.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/projects/id1/status');
    expect(body).toEqual({ status: 'archived' });
    expect(res.status).toBe('archived');
  });
});
