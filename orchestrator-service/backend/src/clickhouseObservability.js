const DEFAULT_URL = 'http://clickhouse:8123';
const DEFAULT_DATABASE = 'orchestrator';
const DEFAULT_TABLE = 'orchestrator_observability_events';
const DEFAULT_TIMEOUT_MS = 1500;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_MS = 1000;
const DEFAULT_MAX_QUEUE = 10000;

const queue = [];
let flushTimer = null;
let flushing = false;

function enabled() {
  return process.env.CLICKHOUSE_OBSERVABILITY_ENABLED === '1';
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

function classifyError(row, reason) {
  const text = `${reason || ''} ${row.error_text || ''}`.toLowerCase();
  if (!text.trim()) return null;
  if (text.includes('usage limit') || text.includes('rate_limit') || text.includes('too many requests') || text.includes('overloaded')) return 'provider_limit';
  if (text.includes('timeout') || text.includes('agent_timeout')) return 'agent_timeout';
  if (text.includes('verdict_unparsed')) return 'verdict_unparsed';
  if (text.includes('missing_required_inputs')) return 'missing_required_inputs';
  if (text.includes('missing_outputs')) return 'missing_outputs';
  if (text.includes('next_role_missing')) return 'route_missing_next_role';
  if (text.includes('decomposition_no_services')) return 'decomposition_no_services';
  if (text.includes('autodeploy_failed')) return 'autodeploy_failed';
  if (text.includes('pipeline')) return 'pipeline_failed';
  if (text.includes('git')) return 'git_integrator_failed';
  if (text.includes('tool_') || text.includes('tool error')) return 'tool_error';
  return 'role_error';
}

async function sendJsonEachRow(rows) {
  if (!enabled() || !rows.length || typeof fetch !== 'function') return { skipped: true };
  const baseUrl = (process.env.CLICKHOUSE_URL || DEFAULT_URL).replace(/\/+$/, '');
  const database = process.env.CLICKHOUSE_DATABASE || DEFAULT_DATABASE;
  const table = process.env.CLICKHOUSE_OBSERVABILITY_TABLE || DEFAULT_TABLE;
  const timeoutMs = safeNumber(process.env.CLICKHOUSE_OBSERVABILITY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const params = new URLSearchParams({
    database,
    async_insert: process.env.CLICKHOUSE_ASYNC_INSERT ?? '1',
    wait_for_async_insert: process.env.CLICKHOUSE_WAIT_FOR_ASYNC_INSERT ?? '0',
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
  });
  const url = `${baseUrl}/?${params.toString()}`;
  const headers = { 'Content-Type': 'application/x-ndjson' };
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:${password || ''}`).toString('base64')}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${clip(await res.text().catch(() => ''), 300)}`);
    return { ok: true, rows: rows.length };
  } finally {
    clearTimeout(timer);
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
    const batchSize = positiveIntEnv('CLICKHOUSE_OBSERVABILITY_BATCH_SIZE', DEFAULT_BATCH_SIZE);
    while (queue.length) {
      const batch = queue.splice(0, batchSize);
      await sendJsonEachRow(batch);
    }
  } catch (error) {
    console.warn?.('[orchestrator-service] ClickHouse observability flush skipped', { error: error.message });
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
    console.warn?.('[orchestrator-service] ClickHouse observability queue overflow', { dropped: drop });
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
      error_class: row.run_status === 'SUCCESS' ? null : classifyError(row, reason),
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
    console.warn?.('[orchestrator-service] ClickHouse observability export skipped', { error: error.message });
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
    console.warn?.('[orchestrator-service] ClickHouse latest-run lookup skipped', { error: error.message });
    return { skipped: true, error: error.message };
  }
}
