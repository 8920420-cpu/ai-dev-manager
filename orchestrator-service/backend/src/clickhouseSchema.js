// Авторитетная идемпотентная схема ClickHouse-стора observability.
//
// Оркестратор сам владеет схемой и накатывает её на старте (ensureClickhouseSchema),
// поэтому стор самодостаточен: не зависит от того, отработали ли init-скрипты infra
// (они запускаются только на пустом volume). Все выражения идемпотентны — их можно
// гонять на каждом старте: CREATE ... IF NOT EXISTS, ALTER ADD COLUMN/INDEX IF NOT
// EXISTS (no-op при наличии), CREATE OR REPLACE VIEW.
//
// error_component — «где искать» (подсистема сбоя), severity — приоритет разбора.
// Держим ORDER BY стабильным (error_component/severity вынесены в skip-индексы, а не
// в ключ сортировки) — иначе существующую таблицу пришлось бы пересоздавать.

import { clickhouseCommand, clickhouseEnabled, observabilityTable } from './clickhouseClient.js';

function names() {
  const db = process.env.CLICKHOUSE_DATABASE || 'orchestrator';
  return { db, table: `${db}.${observabilityTable()}` };
}

// Полное определение таблицы (для свежих volume). Совпадает с миграциями ниже.
function createTableSql(table) {
  return `CREATE TABLE IF NOT EXISTS ${table}
(
    event_id String,
    ts DateTime64(3, 'UTC'),
    event_type LowCardinality(String),
    task_id UUID,
    agent_run_id Nullable(UUID),
    project_id Nullable(UUID),
    service_id Nullable(UUID),
    stage_key Nullable(UUID),
    role_code Nullable(String),
    run_status Nullable(String),
    task_status Nullable(String),
    reason Nullable(String),
    error_class Nullable(String),
    error_component LowCardinality(String) DEFAULT 'none',
    severity LowCardinality(String) DEFAULT 'ok',
    duration_ms UInt64,
    token_input UInt64,
    token_output UInt64,
    token_cache_read Nullable(UInt64),
    token_cache_creation Nullable(UInt64),
    cost Decimal(14, 6),
    cold_start_ms Nullable(UInt64),
    turns Nullable(UInt64),
    outcome Nullable(String),
    provider Nullable(String),
    model Nullable(String),
    driver_type Nullable(String),
    code_version Nullable(String),
    payload_json String CODEC(ZSTD(3)),
    version UInt64 DEFAULT toUnixTimestamp64Milli(ts),
    INDEX idx_role role_code TYPE set(256) GRANULARITY 4,
    INDEX idx_run_status run_status TYPE set(32) GRANULARITY 4,
    INDEX idx_error_class error_class TYPE set(128) GRANULARITY 4,
    INDEX idx_error_component error_component TYPE set(64) GRANULARITY 4,
    INDEX idx_severity severity TYPE set(16) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(ts)
ORDER BY (toDate(ts), event_type, ifNull(role_code, ''), ifNull(run_status, ''), ifNull(error_class, ''), event_id)
TTL toDateTime(ts) + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192`;
}

// Аддитивные миграции для уже существующих таблиц (созданных до этих колонок).
function migrationSql(table) {
  return [
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS error_component LowCardinality(String) DEFAULT 'none' AFTER error_class`,
    `ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS severity LowCardinality(String) DEFAULT 'ok' AFTER error_component`,
    `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_error_component error_component TYPE set(64) GRANULARITY 4`,
    `ALTER TABLE ${table} ADD INDEX IF NOT EXISTS idx_severity severity TYPE set(16) GRANULARITY 4`,
  ];
}

// Аналитические view. severity разделяет реальные сбои (error/fatal) и шум
// (info — released/superseded/отменённые прогоны), который раньше раздувал метрики.
function viewSql(db, table) {
  return [
    `CREATE OR REPLACE VIEW ${db}.run_health_by_hour AS
SELECT
    toStartOfHour(ts) AS hour,
    project_id,
    count() AS runs,
    countIf(severity = 'ok') AS ok,
    countIf(severity = 'info') AS info,
    countIf(severity = 'warning') AS warnings,
    countIf(severity = 'error') AS errors,
    countIf(severity = 'fatal') AS fatal,
    sum(token_input + token_output) AS tokens,
    round(sum(cost), 4) AS cost
FROM ${table} FINAL
GROUP BY hour, project_id`,

    `CREATE OR REPLACE VIEW ${db}.error_breakdown_by_component AS
SELECT
    toDate(ts) AS day,
    project_id,
    error_component,
    severity,
    count() AS events,
    uniqExact(role_code) AS roles,
    uniqExact(task_id) AS tasks,
    any(error_class) AS sample_error_class,
    any(reason) AS sample_reason
FROM ${table} FINAL
WHERE severity NOT IN ('ok', 'info')
GROUP BY day, project_id, error_component, severity`,

    `CREATE OR REPLACE VIEW ${db}.role_failures_by_hour AS
SELECT
    toStartOfHour(ts) AS hour,
    project_id,
    role_code,
    error_component,
    error_class,
    severity,
    count() AS failures,
    any(reason) AS sample_reason,
    round(quantile(0.95)(duration_ms)) AS p95_duration_ms
FROM ${table} FINAL
WHERE severity IN ('error', 'fatal')
GROUP BY hour, project_id, role_code, error_component, error_class, severity`,

    `CREATE OR REPLACE VIEW ${db}.top_error_reasons AS
SELECT
    toDate(ts) AS day,
    project_id,
    error_component,
    error_class,
    role_code,
    reason,
    count() AS failures
FROM ${table} FINAL
WHERE severity IN ('error', 'fatal')
GROUP BY day, project_id, error_component, error_class, role_code, reason`,

    `CREATE OR REPLACE VIEW ${db}.stage_duration_by_role AS
SELECT
    toStartOfHour(ts) AS hour,
    project_id,
    stage_key,
    role_code,
    count() AS runs,
    round(avg(duration_ms)) AS avg_duration_ms,
    round(quantile(0.5)(duration_ms)) AS p50_duration_ms,
    round(quantile(0.95)(duration_ms)) AS p95_duration_ms,
    countIf(severity = 'ok') AS successes,
    countIf(severity = 'warning') AS warnings,
    countIf(severity IN ('error', 'fatal')) AS failures
FROM ${table} FINAL
GROUP BY hour, project_id, stage_key, role_code`,
  ];
}

export function schemaStatements() {
  const { db, table } = names();
  return [
    `CREATE DATABASE IF NOT EXISTS ${db}`,
    createTableSql(table),
    ...migrationSql(table),
    ...viewSql(db, table),
  ];
}

let ensuring = null;

// Накатить схему (best-effort). Возвращает {ok} / {ok:false,error}. Никогда не бросает.
// Дедуплицируется: параллельные вызовы ждут один и тот же прогон.
export async function ensureClickhouseSchema(opts = {}) {
  if (!clickhouseEnabled()) return { skipped: true, reason: 'disabled' };
  if (process.env.CLICKHOUSE_OBSERVABILITY_ENSURE_SCHEMA === '0') return { skipped: true, reason: 'ensure_off' };
  if (ensuring) return ensuring;
  ensuring = (async () => {
    const attempts = Number.isInteger(opts.attempts) ? opts.attempts : 3;
    const retryDelayMs = opts.retryDelayMs ?? 1500;
    let lastErr;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        for (const sql of schemaStatements()) {
          await clickhouseCommand(sql, { timeoutMs: opts.timeoutMs });
        }
        return { ok: true, attempt };
      } catch (error) {
        lastErr = error;
        if (attempt < attempts) await new Promise((r) => setTimeout(r, retryDelayMs));
      }
    }
    return { ok: false, error: lastErr?.message };
  })();
  try {
    return await ensuring;
  } finally {
    ensuring = null;
  }
}
