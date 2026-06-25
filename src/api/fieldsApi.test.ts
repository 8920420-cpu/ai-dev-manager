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

import { fieldsApi } from './fieldsApi';

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  del.mockReset();
});

describe('fieldsApi', () => {
  it('listFields разворачивает { fields }', async () => {
    get.mockResolvedValue({ fields: [{ id: 'f1', key: 'k', name: 'n', description: '', valueType: 'text' }] });
    const list = await fieldsApi.listFields();
    expect(get).toHaveBeenCalledWith('/api/fields', { signal: undefined });
    expect(list).toHaveLength(1);
  });

  it('createField шлёт POST /api/fields с тримом', async () => {
    post.mockResolvedValue({ id: 'f1', key: 'task_id', name: 'Задача', description: '', valueType: 'text' });
    await fieldsApi.createField({ key: '  task_id  ', name: '  Задача  ', valueType: 'text' });
    const [path, body] = post.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/fields');
    expect(body).toMatchObject({ key: 'task_id', name: 'Задача', valueType: 'text' });
  });

  it('getRoleFields бьёт по /api/roles/:code/fields', async () => {
    get.mockResolvedValue({ roleCode: 'PROGRAMMER', inputs: [], outputs: [] });
    await fieldsApi.getRoleFields('PROGRAMMER');
    expect(get).toHaveBeenCalledWith('/api/roles/PROGRAMMER/fields', { signal: undefined });
  });

  it('saveRoleFields шлёт PUT с inputs/outputs', async () => {
    put.mockResolvedValue({
      roleCode: 'PROGRAMMER',
      inputs: [],
      outputs: [],
      changed: false,
      pausedProjects: [],
    });
    await fieldsApi.saveRoleFields('PROGRAMMER', {
      inputs: [{ key: 'task_id', required: true }],
      outputs: [],
    });
    const [path, body] = put.mock.calls[0]! as [string, Record<string, unknown>];
    expect(path).toBe('/api/roles/PROGRAMMER/fields');
    expect(body).toEqual({ inputs: [{ key: 'task_id', required: true }], outputs: [] });
  });
});
