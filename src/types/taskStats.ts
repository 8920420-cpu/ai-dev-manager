/**
 * Контракт `GET /api/projects/:projectId/task-statistics` (orchestrator).
 * См. orchestrator-service/backend/docs/api-projects.md.
 */

export type TimingState = 'active' | 'completed' | 'missing_completion' | 'missing_created';

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
