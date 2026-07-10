import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const put = vi.fn();
vi.mock('./http', () => ({
  http: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    post: vi.fn(),
    del: vi.fn(),
  },
}));

import { roleConnectionsApi } from './roleConnectionsApi';

beforeEach(() => {
  get.mockReset();
  put.mockReset();
});

describe('roleConnectionsApi — REST /api/role-connectors', () => {
  it('list маппит {roleCode,connectorId} → {role,integrationId}', async () => {
    get.mockResolvedValue({
      assignments: [
        { roleCode: 'PROGRAMMER', connectorId: 'int-1', updatedAt: 'x' },
        { roleCode: 'SCANNER', connectorId: null, updatedAt: 'y' },
      ],
    });
    const list = await roleConnectionsApi.list();
    expect(get).toHaveBeenCalledWith('/api/role-connectors');
    expect(list[0]).toMatchObject({ role: 'PROGRAMMER', integrationId: 'int-1' });
    // connectorId:null → пустая строка integrationId.
    expect(list[1]).toMatchObject({ role: 'SCANNER', integrationId: '' });
  });

  it('saveAll шлёт PUT {assignments:[{roleCode,connectorId}]}, пустой → null', async () => {
    put.mockResolvedValue({ assignments: [] });
    await roleConnectionsApi.saveAll([
      { id: 'a', role: 'PROGRAMMER', integrationId: 'int-1' },
      { id: 'b', role: 'SCANNER', integrationId: '' },
      { id: 'c', role: '   ', integrationId: 'int-x' }, // пустая роль отбрасывается
    ]);
    const [path, body] = put.mock.calls[0]! as [string, { assignments: unknown[] }];
    expect(path).toBe('/api/role-connectors');
    expect(body.assignments).toEqual([
      { roleCode: 'PROGRAMMER', connectorId: 'int-1' },
      { roleCode: 'SCANNER', connectorId: null },
    ]);
  });
});
