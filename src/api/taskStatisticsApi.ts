/** Клиент монитора задач проекта (read-only статистика оркестратора). */
import { http } from './http';
import type { TaskStatistics } from '../types/taskStats';

export interface TaskStatsParams {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export const taskStatisticsApi = {
  /**
   * `GET /api/projects/:projectId/task-statistics`. `projectId` — UUID, code
   * или имя проекта в orchestrator_db. Поддерживает отмену через signal.
   */
  async get(projectId: string, params: TaskStatsParams = {}): Promise<TaskStatistics> {
    const q = new URLSearchParams();
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    const qs = q.toString();
    const path = `/api/projects/${encodeURIComponent(projectId)}/task-statistics${qs ? `?${qs}` : ''}`;
    return http.get<TaskStatistics>(path, { signal: params.signal });
  },
};
