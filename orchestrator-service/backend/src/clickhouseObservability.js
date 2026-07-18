// Append-only экспорт завершённых agent_runs в ClickHouse (best-effort).
//
// Postgres остаётся истиной; ClickHouse — быстрый аналитический стор прогонов ролей.
// Недоступность ClickHouse НЕ блокирует транзакции: гейт enabled() + try/catch на
// каждом внешнем вызове. Схема самолечится (ensureClickhouseSchema) на старте и
// лениво — при ошибке «нет таблицы/колонки».
//
// Каждое событие несёт три оси разбора сбоя:
//   error_class     — конкретный код сбоя (что именно упало);
//   error_component — подсистема, «где искать» (provider/git/pipeline/runner/…);
//   severity        — приоритет разбора (ok/info/warning/error/fatal).
// Аналитик фильтрует `severity IN ('error','fatal')` — реальные сбои, без шума
// отменённых/переосвобождённых прогонов (severity='info').

import {
  clickhouseEnabled,
  clickhouseInsertJSONEachRow,
  observabilityTable,
  isMissingSchemaError,
} from './clickhouseClient.js';
import { ensureClickhouseSchema } from './clickhouseSchema.js';
import { createLogger } from '../../../shared/logging/index.js';

const log = createLogger({ service: 'orchestrator-service' });

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_QUEUE = 10000;

const queue = [];
let flushTimer = null;
let flushing = false;
let schemaEnsured = false;

function enabled() {
  return clickhouseEnabled();
}

function clip(value, max) {
  if (value == null) return null;
  const s = String(value);
  return s.length > max ? s.slice(0, max) : s;
}

function jsonString(value) {
  if (value == null) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positiveIntEnv(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function extractReason(row, fallback) {
  if (fallback) return clip(fallback, 500);
  const output = row.output_json && typeof row.output_json === 'object' ? row.output_json : {};
  return clip(output.reason || output.status || row.outcome || row.error_text || row.run_status, 500);
}

// ── Классификация сбоя: (error_class, error_component, severity) ────────────────
// Порядок важен: сначала конкретные причины, в конце — благоприятный lifecycle,
// чтобы «programmer_released: worktree_ensure_failed» классифицировалось по причине
// (git/worktree), а не как обычное освобождение.

const SEV = { OK: 'ok', INFO: 'info', WARN: 'warning', ERROR: 'error', FATAL: 'fatal' };

function mk(errorClass, component, severity) {
  return { error_class: errorClass, error_component: component, severity };
}

const OK = mk(null, 'none', SEV.OK);

// Проблемные вердикты роли на УСПЕШНОМ прогоне (роль отработала, но заблокировала/
// не подтвердила задачу) — не сбой исполнения, но сигнал для анализа (warning).
function classifySuccessVerdict(row, reason) {
  const out = String(row.output_json?.status || '').toUpperCase();
  const text = `${reason || ''}`.toLowerCase();
  if (out === 'INFRASTRUCTURE_BLOCKED' || text.includes('infrastructure_blocked')) return mk('infrastructure_blocked', 'infra', SEV.WARN);
  if (out === 'BLOCKED' || text.includes('docs_blocked')) {
    return text.includes('docs') ? mk('docs_blocked', 'role_logic', SEV.WARN) : mk('verdict_blocked', 'role_logic', SEV.WARN);
  }
  if (out === 'INCONCLUSIVE' || text.includes('inconclusive')) return mk('verdict_inconclusive', 'role_logic', SEV.WARN);
  if (['NEEDS_FIX', 'FIX_REQUIRED', 'DIAGNOSED'].includes(out)) return mk('needs_fix', 'role_logic', SEV.WARN);
  return OK;
}

function classify(row, reason) {
  const status = String(row.run_status || '').toUpperCase();
  if (status === 'SUCCESS') return classifySuccessVerdict(row, reason);

  const out = String(row.output_json?.status || '').toLowerCase();
  const text = `${reason || ''} ${row.error_text || ''} ${row.outcome || ''} ${out}`.toLowerCase();
  const has = (...subs) => subs.some((s) => text.includes(s));

  // 1. Провайдер / коннектор LLM — смотреть логи раннера/коннектора и лимиты подписки.
  if (has('session limit', 'usage limit', 'rate_limit', 'rate limit', 'too many requests', 'quota', 'resets ')) return mk('provider_usage_limit', 'provider', SEV.WARN);
  if (has('overloaded', 'server_overloaded', 'capacity')) return mk('provider_overloaded', 'provider', SEV.WARN);
  if (has('failed to authenticate', 'request not allowed', 'unauthorized', 'invalid api key', 'authentication failed')) return mk('provider_auth', 'provider', SEV.FATAL);
  if (has('ai response timeout', 'upstream timeout', 'connector') && has('timeout')) return mk('provider_timeout', 'provider', SEV.ERROR);

  // 2. Pipeline — смотреть логи pipeline-runner (стадия в error_class).
  if (has('pipeline_no_verification', 'no_verification')) return mk('pipeline_no_verification', 'pipeline', SEV.ERROR);
  if (has('pipeline')) {
    if (has('unit-test', 'unit test', 'vitest', 'jest', 'go test', 'test')) return mk('pipeline_test_failed', 'pipeline', SEV.ERROR);
    if (has('build', 'tsc', 'compile')) return mk('pipeline_build_failed', 'pipeline', SEV.ERROR);
    if (has('deploy', 'rollout')) return mk('pipeline_deploy_failed', 'pipeline', SEV.ERROR);
    if (has('smoke')) return mk('pipeline_smoke_failed', 'pipeline', SEV.ERROR);
    return mk('pipeline_failed', 'pipeline', SEV.ERROR);
  }

  // 3. Автодоставка в k3s — смотреть deploy/autodeploy.json + rollout.
  if (has('autodeploy')) return mk('autodeploy_failed', 'deploy', SEV.ERROR);

  // 4. Git Integrator / worktree — смотреть состояние веток и рабочего дерева.
  if (has('cherry-pick', 'cherry_pick')) return mk('cherry_pick_failed', 'git', SEV.ERROR);
  if (has('dirty worktree', 'dirty_worktree')) return mk('dirty_worktree', 'git', SEV.WARN);
  if (has('worktree_ensure_failed', 'worktree add', 'index.lock')) return mk('worktree_ensure_failed', 'git', SEV.WARN);
  if (has('integrate_conflict', 'already exists in working directory', 'расходится с патчем', 'apply --binary')) return mk('integrate_conflict', 'git', SEV.WARN);
  if (has('git_integrator_failed', 'git integrator')) return mk('git_integrator_failed', 'git', SEV.ERROR);

  // 5. Контракт роли: входы/выходы/маршрутизация/дельта — смотреть карточку и field-контракты.
  if (has('missing_required_inputs')) return mk('missing_required_inputs', 'contract', SEV.ERROR);
  if (has('missing_outputs')) return mk('missing_outputs', 'contract', SEV.ERROR);
  if (has('missing_artifact')) return mk('missing_artifact', 'contract', SEV.ERROR);
  if (has('empty_delta', 'nothing_to_stage', 'no_changed_files', 'no changed files')) return mk('empty_delta', 'contract', SEV.WARN);
  if (has('next_role_missing', 'route_missing', 'no next role')) return mk('route_missing_next_role', 'contract', SEV.ERROR);
  if (has('decomposition_no_services')) return mk('decomposition_no_services', 'contract', SEV.ERROR);

  // 6. Конфигурация проекта/сервиса.
  if (has('repository_path', 'repository path', 'repo path')) return mk('repository_path_missing', 'config', SEV.ERROR);

  // 7. Раннер / жизненный цикл прогона — смотреть вотчдоги раннеров и рестарты.
  if (has('orchestrator restarted', 'orchestrator_restart_reconcile', 'reaped as timeout', 'was reaped')) return mk('orchestrator_restart_reap', 'runner', SEV.WARN);
  if (has('assignment timeout', 'claude_assignment_timeout', 'claim orphaned')) return mk('assignment_timeout', 'runner', SEV.WARN);
  if (has('orphan_run_timeout', 'orphaned mid-run')) return mk('orphan_run_timeout', 'runner', SEV.WARN);
  if (has('maximum number of turns', 'max_turns')) return mk('max_turns_exceeded', 'runner', SEV.ERROR);
  if (has('no_result_message', 'no_result')) return mk('no_result', 'runner', SEV.ERROR);
  if (has('tool_', 'tool error', 'tool-loop', 'tools-service')) return mk('tool_error', 'tooling', SEV.ERROR);
  if (has('role_timeout', 'role execution timed out', 'timed out before producing') || status === 'TIMEOUT') return mk('role_timeout', 'runner', SEV.ERROR);

  // 8. Логика роли / вердикт.
  if (has('verdict_unparsed')) return mk('verdict_unparsed', 'role_logic', SEV.ERROR);
  if (has('infrastructure_blocked')) return mk('infrastructure_blocked', 'infra', SEV.ERROR);
  if (has('docs_blocked')) return mk('docs_blocked', 'role_logic', SEV.WARN);
  if (has('max_rework_exceeded', 'max_rework')) return mk('max_rework_exceeded', 'role_logic', SEV.WARN);
  if (has('inconclusive')) return mk('verdict_inconclusive', 'role_logic', SEV.WARN);
  if (has('blocked')) return mk('verdict_blocked', 'role_logic', SEV.WARN);
  if (has('role_failed')) return mk('role_failed', 'role_logic', SEV.ERROR);

  // 9. Благоприятный жизненный цикл: переосвобождение/вытеснение — не сбой (шум).
  if (has('released', 'superseded', 'refeed', 're-fed', 'requeued', 'reassigned')) return mk('released', 'lifecycle', SEV.INFO);

  // 10. Фолбэк по статусу прогона.
  if (status === 'CANCELLED') return mk('cancelled', 'lifecycle', SEV.INFO);
  if (status === 'FAILED') return mk('role_failed', 'unknown', SEV.ERROR);
  return mk('unknown_error', 'unknown', SEV.WARN);
}

async function ensureSchemaOnce() {
  if (schemaEnsured) return;
  const r = await ensureClickhouseSchema();
  if (r?.ok || r?.skipped) schemaEnsured = true;
}

async function sendBatch(rows) {
  const table = observabilityTable();
  try {
    return await clickhouseInsertJSONEachRow(table, rows);
  } catch (error) {
    // Ленивый self-heal: таблица/колонка отсутствуют → накатить схему и повторить один раз.
    if (isMissingSchemaError(error)) {
      schemaEnsured = false;
      await ensureSchemaOnce();
      return clickhouseInsertJSONEachRow(table, rows);
    }
    throw error;
  }
}

function scheduleFlush() {
  if (flushTimer || flushing) return;
  const flushMs = positiveIntEnv('CLICKHOUSE_OBSERVABILITY_FLUSH_MS', DEFAULT_FLUSH_MS);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, flushMs);
  flushTimer.unref?.();
}

async function flushQueue() {
  if (flushing || !queue.length) return;
  flushing = true;
  try {
    await ensureSchemaOnce();
    const batchSize = positiveIntEnv('CLICKHOUSE_OBSERVABILITY_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      await sendBatch(batch);
    }
  } catch (error) {
    log.warn('ClickHouse observability flush skipped', { event_code: 'OBSERVABILITY_EXPORT_SKIPPED', operation: 'clickhouse.flush', err: error });
  } finally {
    flushing = false;
    if (queue.length) scheduleFlush();
  }
}

function enqueueRows(rows) {
  if (!enabled() || !rows.length) return { skipped: true };
  const maxQueue = positiveIntEnv('CLICKHOUSE_OBSERVABILITY_MAX_QUEUE', DEFAULT_MAX_QUEUE);
  if (queue.length + rows.length > maxQueue) {
    const drop = queue.length + rows.length - maxQueue;
    queue.splice(0, drop);
    log.warn('ClickHouse observability queue overflow', { event_code: 'OBSERVABILITY_EXPORT_SKIPPED', operation: 'clickhouse.enqueue', attributes: { dropped: drop } });
  }
  queue.push(...rows);
  if (queue.length >= positiveIntEnv('CLICKHOUSE_OBSERVABILITY_BATCH_SIZE', DEFAULT_BATCH_SIZE)) {
    void flushQueue();
  } else {
    scheduleFlush();
  }
  return { queued: true, rows: rows.length, queueSize: queue.length };
}

export async function exportAgentRunObservation(c, agentRunId, meta = {}) {
  if (!enabled() || !agentRunId) return { skipped: true };
  try {
    const r = await c.query(
      `SELECT ar.id::text AS agent_run_id, ar.task_id::text AS task_id,
              ar.status::text AS run_status, ar.started_at, ar.finished_at,
              GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(ar.finished_at, now()) - COALESCE(ar.started_at, now()))) * 1000)::bigint AS duration_ms,
              ar.error_text, ar.output_json, ar.token_input, ar.token_output,
              ar.token_cache_read, ar.token_cache_creation, ar.cost,
              ar.cold_start_ms, ar.turns, ar.outcome, ar.code_version, ar.model,
              ar.snapshot_provider, ar.snapshot_model, ar.snapshot_driver_type,
              t.project_id::text AS project_id, t.service_id::text AS service_id,
              t.current_stage_key::text AS stage_key, t.status::text AS task_status,
              r.code AS role_code
         FROM agent_runs ar
         JOIN tasks t ON t.id = ar.task_id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.id = $1`,
      [agentRunId],
    );
    const row = r.rows[0];
    if (!row) return { skipped: true };
    const reason = extractReason(row, meta.reason);
    const eventType = meta.eventType || 'agent_run_finished';
    const cls = classify(row, reason);
    return enqueueRows([{
      event_id: `${row.agent_run_id}:${eventType}`,
      ts: new Date().toISOString().replace('T', ' ').replace('Z', ''),
      event_type: eventType,
      task_id: row.task_id,
      agent_run_id: row.agent_run_id,
      project_id: row.project_id || null,
      service_id: row.service_id || null,
      stage_key: row.stage_key || null,
      role_code: row.role_code || null,
      run_status: row.run_status || null,
      task_status: row.task_status || null,
      reason,
      error_class: cls.error_class,
      error_component: cls.error_component,
      severity: cls.severity,
      duration_ms: safeNumber(row.duration_ms),
      token_input: safeNumber(row.token_input),
      token_output: safeNumber(row.token_output),
      token_cache_read: row.token_cache_read == null ? null : safeNumber(row.token_cache_read),
      token_cache_creation: row.token_cache_creation == null ? null : safeNumber(row.token_cache_creation),
      cost: safeNumber(row.cost),
      cold_start_ms: row.cold_start_ms == null ? null : safeNumber(row.cold_start_ms),
      turns: row.turns == null ? null : safeNumber(row.turns),
      outcome: row.outcome || null,
      provider: row.snapshot_provider || null,
      model: row.snapshot_model || row.model || null,
      driver_type: row.snapshot_driver_type || null,
      code_version: row.code_version || null,
      payload_json: jsonString({ ...meta.payload, output: row.output_json ?? null, errorText: row.error_text ?? null }),
    }]);
  } catch (error) {
    log.warn('ClickHouse observability export skipped', { event_code: 'OBSERVABILITY_EXPORT_SKIPPED', operation: 'clickhouse.export', err: error });
    return { skipped: true, error: error.message };
  }
}

export async function exportLatestAgentRunObservation(c, taskId, meta = {}) {
  if (!enabled() || !taskId) return { skipped: true };
  try {
    const params = [taskId];
    let roleFilter = '';
    if (meta.roleCode) {
      params.push(meta.roleCode);
      roleFilter = `AND r.code = $${params.length}`;
    }
    const r = await c.query(
      `SELECT ar.id::text AS id
         FROM agent_runs ar
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE ar.task_id = $1
          AND ar.finished_at IS NOT NULL
          ${roleFilter}
        ORDER BY ar.finished_at DESC, ar.started_at DESC
        LIMIT 1`,
      params,
    );
    return exportAgentRunObservation(c, r.rows[0]?.id, meta);
  } catch (error) {
    log.warn('ClickHouse latest-run lookup skipped', { event_code: 'OBSERVABILITY_EXPORT_SKIPPED', operation: 'clickhouse.latest_lookup', err: error });
    return { skipped: true, error: error.message };
  }
}

// Экспортируется для юнит-тестов таксономии.
export const __test__ = { classify, classifySuccessVerdict };
