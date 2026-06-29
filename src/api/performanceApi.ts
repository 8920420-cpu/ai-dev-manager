/**
 * PERFORMANCE-MONITOR-001 — НЕ-AI метрики оркестратора (read-only).
 *   GET /api/performance[?projectId=...] → сводка KPI без участия модели.
 */
import { http } from './http';

export interface RoleLoad {
  roleCode: string;
  roleName: string;
  runs: number;
  success: number;
  failed: number;
  timeout: number;
  running: number;
  avgDurationMs: number | null;
  // OBSERVABILITY-REASONING-001: токены и холодный старт по ролям (за 24ч).
  tokensIn: number;
  tokensOut: number;
  cost: number;
  avgColdStartMs: number | null;
}

export interface ConnectorBucket {
  key: string;
  limit: number;
  active: number;
  free: number;
  queued: number;
  tpm: number;
  canSend: boolean;
}

export interface PerformanceMetrics {
  generatedAt: string;
  projectId: string | null;
  tasks: {
    byStatus: Record<string, number>;
    total: number;
    active: number;
    blocked: number;
    completed: number;
    done: number;
    cancelled: number;
    failed: number;
  };
  queue: {
    backlog: number;
    codingUnclaimed: number;
    review: number;
    restart: number;
  };
  throughput: {
    completedLastHour: number;
    completedLast24h: number;
    createdLast24h: number;
  };
  rework: {
    transitions: number;
    reworkExtra: number;
    retryRate: number;
  };
  timings: {
    averageCompletedDurationMs: number | null;
  };
  programmer: {
    avgPasses: number | null;
    maxPasses: number | null;
    completions: number;
    limitHits: number;
  };
  roleLoad: RoleLoad[];
  connector: Record<string, ConnectorBucket>;
}

export const performanceApi = {
  async get(projectId?: string, signal?: AbortSignal): Promise<PerformanceMetrics> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return http.get<PerformanceMetrics>(`/api/performance${qs}`, { signal });
  },
};
