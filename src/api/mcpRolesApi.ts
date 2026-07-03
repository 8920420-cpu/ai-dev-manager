/**
 * Клиент раздела «MCP роли» — роли, используемые через MCP.
 * Контракт: orchestrator-service/backend/docs/api-mcp-roles.md (MCP-ROLES-001).
 *
 * Идентичность роли — её `code` (задаётся при создании, далее не меняется).
 * MCP-роль хранит промт (`prompt`) и требования к роли (`requirements`).
 *
 * Endpoints:
 *   GET    /api/mcp-roles          → список MCP-ролей
 *   POST   /api/mcp-roles          → создать роль
 *   GET    /api/mcp-roles/:code    → одна карточка (404 mcp_role_not_found)
 *   PUT    /api/mcp-roles/:code    → частичное обновление
 *   DELETE /api/mcp-roles/:code    → удалить роль
 */
import { http } from './http';
import type { McpRole, McpRoleCreate, McpRolePatch } from '../types/settings';

export const mcpRolesApi = {
  /** Список MCP-ролей. */
  async list(signal?: AbortSignal): Promise<McpRole[]> {
    const { roles } = await http.get<{ roles: McpRole[] }>('/api/mcp-roles', { signal });
    return roles ?? [];
  },

  /** Одна карточка MCP-роли по коду. */
  async get(code: string, signal?: AbortSignal): Promise<McpRole> {
    return http.get<McpRole>(`/api/mcp-roles/${encodeURIComponent(code)}`, { signal });
  },

  /** Создать MCP-роль. Ответ — созданная карточка. */
  async create(input: McpRoleCreate): Promise<McpRole> {
    return http.post<McpRole>('/api/mcp-roles', input);
  },

  /** Частичное обновление: меняются только переданные поля. `code` не меняется. */
  async update(code: string, patch: McpRolePatch): Promise<McpRole> {
    return http.put<McpRole>(`/api/mcp-roles/${encodeURIComponent(code)}`, patch);
  },

  /** Удалить MCP-роль. */
  async remove(code: string): Promise<void> {
    await http.del(`/api/mcp-roles/${encodeURIComponent(code)}`);
  },
};
