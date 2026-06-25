/**
 * Реестр инструментов (Tools) и уровни доступа/назначение ролям.
 * Контракт: orchestrator-service/backend/src/tools.js (TOOLS-REGISTRY-001).
 *
 * Endpoints:
 *   GET/POST            /api/tools                 — реестр инструментов
 *   GET/PUT/DELETE      /api/tools/:id             — один инструмент
 *   GET/PUT             /api/roles/:code/capabilities — уровни доступа роли
 *   GET/PUT             /api/roles/:code/tools     — назначенные роли MCP-инструменты
 */
import { http } from './http';
import type { Tool, ToolInput, ToolCapability } from '../types/settings';

export const toolsApi = {
  async list(signal?: AbortSignal): Promise<Tool[]> {
    const { tools } = await http.get<{ tools: Tool[] }>('/api/tools', { signal });
    return tools ?? [];
  },

  async create(input: ToolInput): Promise<Tool> {
    return http.post<Tool>('/api/tools', input);
  },

  async update(id: string, patch: Partial<ToolInput>): Promise<Tool> {
    return http.put<Tool>(`/api/tools/${encodeURIComponent(id)}`, patch);
  },

  async remove(id: string): Promise<void> {
    await http.del(`/api/tools/${encodeURIComponent(id)}`);
  },

  /** Уровни доступа роли (read/modify/create/delete/execute). */
  async getCapabilities(roleCode: string, signal?: AbortSignal): Promise<ToolCapability[]> {
    const { capabilities } = await http.get<{ capabilities: ToolCapability[] }>(
      `/api/roles/${encodeURIComponent(roleCode)}/capabilities`,
      { signal },
    );
    return capabilities ?? [];
  },

  async saveCapabilities(roleCode: string, capabilities: ToolCapability[]): Promise<ToolCapability[]> {
    const res = await http.put<{ capabilities: ToolCapability[] }>(
      `/api/roles/${encodeURIComponent(roleCode)}/capabilities`,
      { capabilities },
    );
    return res.capabilities ?? [];
  },

  /** MCP-инструменты, назначенные роли (id'ы). */
  async getRoleTools(roleCode: string, signal?: AbortSignal): Promise<string[]> {
    const { toolIds } = await http.get<{ toolIds: string[] }>(
      `/api/roles/${encodeURIComponent(roleCode)}/tools`,
      { signal },
    );
    return toolIds ?? [];
  },

  async saveRoleTools(roleCode: string, toolIds: string[]): Promise<string[]> {
    const res = await http.put<{ toolIds: string[] }>(
      `/api/roles/${encodeURIComponent(roleCode)}/tools`,
      { toolIds },
    );
    return res.toolIds ?? [];
  },
};
