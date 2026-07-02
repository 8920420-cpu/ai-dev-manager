import { http } from './http';
import type { ManagedServerAction, ServersResponse } from '../types/server';

export const serversApi = {
  get(signal?: AbortSignal): Promise<ServersResponse> {
    return http.get<ServersResponse>('/api/servers', { signal });
  },

  action(id: string, action: ManagedServerAction): Promise<ServersResponse> {
    return http.post<ServersResponse>(`/api/servers/${encodeURIComponent(id)}/actions`, { action }, {
      timeoutMs: action === 'pull' ? 120000 : 60000,
    });
  },
};
