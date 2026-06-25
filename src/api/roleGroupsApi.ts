/**
 * Репозиторий смысловых групп ролей — REST оркестратора (ROLE-GROUPS-001).
 *
 * Группа — управляемая сущность экрана «Настройки → Роли»: создание,
 * переименование, удаление. Роли распределяются по группам через
 * `RoleCard.groupId` (PUT /api/roles/:code). Удаление группы открепляет её роли
 * (они уходят в «Прочее»). Раскладка не влияет на рантайм пайплайна.
 *
 * Endpoints:
 *   GET    /api/role-groups        → список групп (по sort_order, name)
 *   POST   /api/role-groups        → создать группу { name }
 *   PUT    /api/role-groups/:id    → переименовать/переупорядочить { name?, sortOrder? }
 *   DELETE /api/role-groups/:id    → удалить (роли группы → «Прочее»)
 */
import { http } from './http';
import type { RoleGroup } from '../types/settings';

export const roleGroupsApi = {
  /** Список всех смысловых групп. */
  async list(signal?: AbortSignal): Promise<RoleGroup[]> {
    const { groups } = await http.get<{ groups: RoleGroup[] }>('/api/role-groups', { signal });
    return groups ?? [];
  },

  /** Создать новую группу. Имя уникально без учёта регистра. */
  async create(name: string): Promise<RoleGroup> {
    return http.post<RoleGroup>('/api/role-groups', { name });
  },

  /** Переименовать и/или изменить порядок группы. */
  async update(id: string, patch: { name?: string; sortOrder?: number }): Promise<RoleGroup> {
    return http.put<RoleGroup>(`/api/role-groups/${encodeURIComponent(id)}`, patch);
  },

  /** Удалить группу: её роли возвращаются в «Прочее». */
  async remove(id: string): Promise<{ ok: boolean; detachedRoles: number }> {
    return http.del<{ ok: boolean; detachedRoles: number }>(
      `/api/role-groups/${encodeURIComponent(id)}`,
    );
  },
};
