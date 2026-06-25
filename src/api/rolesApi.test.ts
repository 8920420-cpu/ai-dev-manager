import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const put = vi.fn();
vi.mock('./http', () => ({
  http: {
    get: (...a: unknown[]) => get(...a),
    post: vi.fn(),
    put: (...a: unknown[]) => put(...a),
    del: vi.fn(),
  },
}));

import { rolesApi } from './rolesApi';

beforeEach(() => {
  get.mockReset();
  put.mockReset();
});

describe('rolesApi — контракт /api/roles и /api/skills', () => {
  it('list читает массив карточек из { roles }', async () => {
    get.mockResolvedValue({
      roles: [
        { code: 'ARCHITECT', name: 'Architect', description: 'd', prompt: '', groupId: 'g1', skills: [] },
      ],
    });
    const list = await rolesApi.list();
    expect(get).toHaveBeenCalledWith('/api/roles', { signal: undefined });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: 'ARCHITECT', groupId: 'g1' });
  });

  it('list возвращает [] при пустом ответе', async () => {
    get.mockResolvedValue({});
    expect(await rolesApi.list()).toEqual([]);
  });

  it('get обращается к /api/roles/:code с экранированием', async () => {
    get.mockResolvedValue({ code: 'TASK_REVIEWER', name: 'Task Reviewer' });
    await rolesApi.get('TASK_REVIEWER');
    expect(get).toHaveBeenCalledWith('/api/roles/TASK_REVIEWER', { signal: undefined });
  });

  it('update отправляет PUT c частичным телом (description/prompt/groupId/skills)', async () => {
    put.mockResolvedValue({
      code: 'PROGRAMMER',
      name: 'Programmer',
      description: 'desc',
      prompt: 'p',
      groupId: 'g1',
      skills: ['a.md'],
    });
    const saved = await rolesApi.update('PROGRAMMER', {
      description: 'desc',
      prompt: 'p',
      groupId: 'g1',
      skills: ['a.md'],
    });
    const [path, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/roles/PROGRAMMER');
    expect(body).toEqual({ description: 'desc', prompt: 'p', groupId: 'g1', skills: ['a.md'] });
    expect(saved.groupId).toBe('g1');
  });

  it('update позволяет менять только группу (минимальный patch)', async () => {
    put.mockResolvedValue({ code: 'SCANNER', name: 'Scanner', groupId: null });
    await rolesApi.update('SCANNER', { groupId: null });
    const [, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(body).toEqual({ groupId: null });
  });

  it('listSkills читает доступные файлы из { skills }', async () => {
    get.mockResolvedValue({ skills: [{ id: 'group/a.md', name: 'a.md' }] });
    const list = await rolesApi.listSkills();
    expect(get).toHaveBeenCalledWith('/api/skills', { signal: undefined });
    expect(list[0]).toEqual({ id: 'group/a.md', name: 'a.md' });
  });

  it('listSkills возвращает [] для несуществующего каталога', async () => {
    get.mockResolvedValue({});
    expect(await rolesApi.listSkills()).toEqual([]);
  });
});
