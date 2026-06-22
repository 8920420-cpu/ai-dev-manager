/**
 * Репозиторий соответствий «роль → коннектор» — REST оркестратора
 * (`/api/role-connectors`).
 *
 * Серверный контракт: `{ roleCode, connectorId|null, updatedAt }`.
 * Во фронтовом типе RoleConnection поле `role` хранит канонический roleCode,
 * `integrationId` — connectorId (или '' если назначение снято).
 */
import { http } from './http';
import { makeId } from '../lib/format';
import type { RoleConnection } from '../types/settings';

interface AssignmentRow {
  roleCode: string;
  connectorId: string | null;
  updatedAt?: string;
}

function fromRow(row: AssignmentRow): RoleConnection {
  return {
    id: makeId('rc'),
    role: row.roleCode,
    integrationId: row.connectorId ?? '',
  };
}

export const roleConnectionsApi = {
  async list(): Promise<RoleConnection[]> {
    const { assignments } = await http.get<{ assignments: AssignmentRow[] }>(
      '/api/role-connectors',
    );
    return (assignments ?? []).map(fromRow);
  },

  /** Массовое сохранение назначений (PUT). Пустой integrationId → connectorId=null. */
  async saveAll(items: RoleConnection[]): Promise<RoleConnection[]> {
    const assignments = items
      .filter((r) => r.role.trim())
      .map((r) => ({
        roleCode: r.role.trim(),
        connectorId: r.integrationId.trim() || null,
      }));
    const { assignments: saved } = await http.put<{ assignments: AssignmentRow[] }>(
      '/api/role-connectors',
      { assignments },
    );
    return (saved ?? []).map(fromRow);
  },

  make(role = '', integrationId = ''): RoleConnection {
    return { id: makeId('rc'), role, integrationId };
  },
};
