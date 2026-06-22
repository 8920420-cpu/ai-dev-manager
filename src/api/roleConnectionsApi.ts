/**
 * Репозиторий соответствий «роль → коннектор».
 * ⚠️ BACKEND_REQUIRED: серверного API пока нет — данные хранятся локально.
 */
import { createCollectionRepo } from './localStore';
import { makeId } from '../lib/format';
import type { RoleConnection } from '../types/settings';

const repo = createCollectionRepo<RoleConnection>('roleConnections');

export const roleConnectionsApi = {
  async list(): Promise<RoleConnection[]> {
    return repo.list();
  },

  async saveAll(items: RoleConnection[]): Promise<RoleConnection[]> {
    return repo.saveAll(items);
  },

  make(role = '', integrationId = ''): RoleConnection {
    return { id: makeId('rc'), role, integrationId };
  },
};
