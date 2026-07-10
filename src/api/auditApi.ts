/**
 * ORCHESTRATOR-AUDITOR-001 — ручной запуск аудита оркестратора (off-route).
 *   POST /api/audit/run   → поставить аудит в очередь (идемпотентно)
 *   GET  /api/audit/runs  → последние запуски аудита
 */
import { http } from './http';

export type AuditStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED';

export interface AuditRun {
  id: string;
  status: AuditStatus;
  requestedBy: string | null;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  report: string | null;
  scores: Record<string, number> | null;
  errorText: string | null;
}

export const auditApi = {
  async run(): Promise<{ run: AuditRun; alreadyQueued: boolean }> {
    return http.post<{ run: AuditRun; alreadyQueued: boolean }>('/api/audit/run', {});
  },

  async list(signal?: AbortSignal): Promise<AuditRun[]> {
    const { runs } = await http.get<{ runs: AuditRun[] }>('/api/audit/runs', { signal });
    return runs ?? [];
  },
};
