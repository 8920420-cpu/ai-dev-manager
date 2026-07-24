/**
 * Контракт `GET /api/projects/:projectId/task-statistics` (orchestrator).
 * См. orchestrator-service/backend/docs/api-projects.md.
 */

export type TimingState = 'active' | 'completed' | 'missing_completion' | 'missing_created';

/**
 * KPI задачи (агрегат `agent_runs`): токены/стоимость/прогоны.
 * `tokenFreshInput` — свежий ввод без кэша (`tokenInput − cacheRead − cacheCreation`).
 * Источник — backend `taskStats.normalizeKpi` (OBSERVABILITY-BLOCK-KPI-001).
 */
export interface TaskKpi {
  tokenInput: number;
  tokenOutput: number;
  tokenCacheRead: number;
  tokenCacheCreation: number;
  tokenFreshInput: number;
  cost: number;
  turns: number;
  runs: number;
  failedRuns: number;
}

/** Причина блокировки задачи (последнее событие `to_status='BLOCKED'`). */
export interface TaskBlockReason {
  note: string | null;
  error: string | null;
  role: string | null;
  at: string | null;
}

/** Одна строка монитора задач. */
export interface TaskStatRow {
  id: string;
  title: string;
  service: string | null;
  status: string;
  stageCode: string;
  stageName: string;
  createdAt: string | null;
  stageStartedAt: string | null;
  completedAt: string | null;
  /** мс на текущем этапе; `null` — нет надёжной отметки. */
  stageDurationMs: number | null;
  /** мс за весь жизненный цикл; `null` — нет надёжной отметки. */
  totalDurationMs: number | null;
  timingState: TimingState;
  /** Причина блокировки (или `null`). Наблюдаемость OBSERVABILITY-BLOCK-KPI-001. */
  blockReason: TaskBlockReason | null;
  /** KPI токенов/стоимости/прогонов задачи. */
  kpi: TaskKpi;
  /**
   * Документационная ветка force-продвинута к join сетью безопасности
   * (`documentation_branch_advanced`): DONE без реального прогона движка доков.
   */
  docForcedAdvance: boolean;
}

export interface TaskStatSummary {
  total: number;
  active: number;
  completed: number;
  blocked: number;
  byStage: Record<string, number>;
  averageCompletedDurationMs: number | null;
}

export interface TaskStatistics {
  projectId: string;
  /** Серверная отметка времени ответа (единая для всех длительностей). */
  generatedAt: string;
  summary: TaskStatSummary;
  pagination: { limit: number; offset: number; total: number };
  tasks: TaskStatRow[];
}
