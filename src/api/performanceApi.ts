/**
 * PERFORMANCE-MONITOR-001 — НЕ-AI метрики оркестратора (read-only).
 *   GET /api/performance[?projectId=...] → сводка KPI без участия модели.
 */
import { http } from './http';

export interface RoleLoad {
  roleCode: string;
  roleName: string;
  runs: number;
  // ROLE-LOAD-AVG-001: число задач в окне (знаменатель средних на задачу).
  tasks: number;
  success: number;
  failed: number;
  timeout: number;
  running: number;
  avgDurationMs: number | null;
  // OBSERVABILITY-REASONING-001: суммарные токены по ролям за окно (для разбивки кэша).
  tokensIn: number;
  tokensOut: number;
  // TOKEN-SPLIT-001: деление входа. tokensIn = свежий + запись в кэш + чтение из кэша.
  // cacheRead копится по ходам tool-loop и обычно доминирует (billed ~10%).
  tokensInputFresh: number;
  tokensCacheCreation: number;
  tokensCacheRead: number;
  cost: number;
  // ROLE-LOAD-AVG-001: средние на задачу для основного вида (null при tasks = 0).
  avgTokensInPerTask: number | null;
  avgTokensOutPerTask: number | null;
  avgCostPerTask: number | null;
  avgColdStartMs: number | null;
}

// ROLE-LOAD-LAST-DATA-001: окно блока «Нагрузка по ролям» заякорено к последней
// активности. stale=true — оркестратор простаивает дольше окна, но показываются
// последние имевшиеся данные (windowEnd — время последнего прогона).
export interface RoleLoadWindow {
  stale: boolean;
  staleHours: number;
  windowStart: string | null;
  windowEnd: string | null;
  lastActivityAt: string | null;
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
  roleLoadWindow: RoleLoadWindow;
  connector: Record<string, ConnectorBucket>;
}

// ROLE-LOAD-LAST-DATA-001 — суммарные значения блока «Нагрузка по ролям» за период
// (вкладка «Суммы»). Всё суммарно за окно месяц/неделя/день, без усреднения.
export type RoleLoadPeriod = 'month' | 'week' | 'day';

export interface RoleLoadTotalRow {
  roleCode: string;
  roleName: string;
  runs: number;
  tasks: number;
  success: number;
  failed: number;
  timeout: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
}

export interface RoleLoadTotals extends RoleLoadWindow {
  generatedAt: string;
  period: RoleLoadPeriod;
  windowDays: number;
  roles: RoleLoadTotalRow[];
}

// VERSION-KPI-TRACKING-001 — KPI роли по версиям (код/промт/модель) и дельты.

export interface VersionDelta {
  abs: number;
  pct: number | null;
}

export interface VersionRow {
  promptVersion: number | null;
  promptLabel: string | null;
  codeVersion: string | null;
  model: string | null;
  n: number;
  success?: number;
  failed?: number;
  timeout?: number;
  limitHits?: number;
  maxPasses?: number | null;
  successRate: number | null;
  avgDurationMs: number | null;
  avgTokensIn: number | null;
  avgTokensOut: number | null;
  avgCost: number | null;
  avgColdStartMs: number | null;
  avgTurns: number | null;
  avgPasses: number | null;
  firstRun: string | null;
  lastRun: string | null;
  delta: Record<string, VersionDelta | null>;
  enoughData: boolean;
  regression: boolean;
  regressedMetrics: string[];
}

export interface KpiMarker {
  id: string;
  type: string;
  ref: string | null;
  description: string | null;
  roleCode: string | null;
  createdAt: string;
}

export interface VersionMetrics {
  generatedAt: string;
  role: { code: string; name: string };
  windowHours: number;
  source: 'agent_runs' | 'task_events';
  minSample: number;
  regressionPct: number;
  versions: VersionRow[];
  markers: KpiMarker[];
}

export const performanceApi = {
  async get(projectId?: string, signal?: AbortSignal): Promise<PerformanceMetrics> {
    const qs = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return http.get<PerformanceMetrics>(`/api/performance${qs}`, { signal });
  },

  async versions(
    role: string,
    opts: { windowHours?: number; projectId?: string } = {},
    signal?: AbortSignal,
  ): Promise<VersionMetrics> {
    const params = new URLSearchParams({ role });
    if (opts.windowHours) params.set('windowHours', String(opts.windowHours));
    if (opts.projectId) params.set('projectId', opts.projectId);
    return http.get<VersionMetrics>(`/api/performance/versions?${params.toString()}`, { signal });
  },

  // ROLE-LOAD-LAST-DATA-001: суммарные значения блока «Нагрузка по ролям» за период.
  async roleLoadTotals(
    period: RoleLoadPeriod,
    signal?: AbortSignal,
  ): Promise<RoleLoadTotals> {
    return http.get<RoleLoadTotals>(
      `/api/performance/role-load-totals?period=${encodeURIComponent(period)}`,
      { signal },
    );
  },

  async createMarker(
    input: { type?: string; ref?: string; description?: string; role?: string },
    signal?: AbortSignal,
  ): Promise<KpiMarker> {
    return http.post<KpiMarker>('/api/kpi-markers', input, { signal });
  },
};
