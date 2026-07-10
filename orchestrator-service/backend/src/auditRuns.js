// ORCHESTRATOR-AUDITOR-001 — очередь и журнал запусков аудита оркестратора.
//
// Аудит — off-route операция (вне цепочки задач). Кнопка в UI создаёт PENDING-
// запуск; исполнитель аудита (сейчас — внешняя Claude-сессия, как стадия CODING;
// позже — авто-runner) забирает его, пишет отчёт и оценки. Модуль НЕ запускает
// ИИ сам — только ведёт учёт в таблице audit_runs (см. миграцию 0033).
import { withClient, clientConfig } from './db.js';

import { httpCodedError as httpError } from './httpError.js';

const MAX_LIST = 50;

function mapRun(row) {
  return {
    id: row.id,
    status: row.status,
    requestedBy: row.requested_by ?? null,
    requestedAt: row.requested_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    report: row.report ?? null,
    scores: row.scores ?? null,
    errorText: row.error_text ?? null,
  };
}

/**
 * POST /api/audit/run — поставить аудит в очередь. Если уже есть незавершённый
 * запуск (PENDING/RUNNING) — возвращаем его (идемпотентно, без дублей очереди).
 */
export async function createAuditRun(s, input = {}) {
  const requestedBy =
    input && typeof input.requestedBy === 'string' ? input.requestedBy.slice(0, 200) : null;
  return withClient(clientConfig(s), async (c) => {
    const pending = await c.query(
      `SELECT * FROM audit_runs WHERE status IN ('PENDING', 'RUNNING')
        ORDER BY requested_at DESC LIMIT 1`,
    );
    if (pending.rowCount) {
      return { run: mapRun(pending.rows[0]), alreadyQueued: true };
    }
    const r = await c.query(
      `INSERT INTO audit_runs (requested_by) VALUES ($1) RETURNING *`,
      [requestedBy],
    );
    return { run: mapRun(r.rows[0]), alreadyQueued: false };
  });
}

/** GET /api/audit/runs — последние запуски аудита (новые сверху). */
export async function listAuditRuns(s, { limit } = {}) {
  let lim = Number.parseInt(limit, 10);
  if (!Number.isFinite(lim) || lim <= 0) lim = 20;
  if (lim > MAX_LIST) lim = MAX_LIST;
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT * FROM audit_runs ORDER BY requested_at DESC LIMIT $1`,
      [lim],
    );
    return { runs: r.rows.map(mapRun) };
  });
}

/**
 * POST /api/audit/runs/:id/complete — исполнитель сдаёт результат аудита.
 * status: DONE | FAILED. Для DONE пишем report/scores, для FAILED — error_text.
 */
export async function completeAuditRun(s, id, input = {}) {
  const runId = String(id ?? '').trim();
  if (!runId) throw httpError(422, 'audit_run_id_required');
  const status = String(input.status ?? 'DONE').toUpperCase();
  if (!['DONE', 'FAILED'].includes(status)) throw httpError(422, 'audit_status_invalid');
  const report = input.report == null ? null : String(input.report).slice(0, 500000);
  const scores =
    input.scores == null ? null : typeof input.scores === 'object' ? input.scores : null;
  const errorText = input.errorText == null ? null : String(input.errorText).slice(0, 5000);
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `UPDATE audit_runs
          SET status = $2, finished_at = now(), report = $3,
              scores = $4::jsonb, error_text = $5
        WHERE id = $1
        RETURNING *`,
      [runId, status, report, scores == null ? null : JSON.stringify(scores), errorText],
    );
    if (!r.rowCount) throw httpError(404, 'audit_run_not_found');
    return { run: mapRun(r.rows[0]) };
  });
}
