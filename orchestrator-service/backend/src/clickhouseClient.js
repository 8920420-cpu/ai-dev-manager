// Тонкий HTTP-клиент ClickHouse: общая точка для observability-вставок и DDL.
//
// Контракт: функции здесь БРОСАЮТ при не-2xx / сетевой ошибке. Гейт доступности
// (CLICKHOUSE_OBSERVABILITY_ENABLED) и обёртка try/catch — на стороне вызывающего
// (clickhouseObservability.js / clickhouseSchema.js), чтобы недоступность ClickHouse
// никогда не блокировала Postgres-транзакции оркестратора.

const DEFAULT_URL = 'http://clickhouse:8123';
const DEFAULT_DATABASE = 'orchestrator';
const DEFAULT_INSERT_TIMEOUT_MS = 1500;
const DEFAULT_DDL_TIMEOUT_MS = 8000;

export function clickhouseEnabled() {
  return process.env.CLICKHOUSE_OBSERVABILITY_ENABLED === '1';
}

export function clickhouseConfig() {
  return {
    baseUrl: (process.env.CLICKHOUSE_URL || DEFAULT_URL).replace(/\/+$/, ''),
    database: process.env.CLICKHOUSE_DATABASE || DEFAULT_DATABASE,
    user: process.env.CLICKHOUSE_USER || '',
    password: process.env.CLICKHOUSE_PASSWORD || '',
  };
}

export function observabilityTable() {
  return process.env.CLICKHOUSE_OBSERVABILITY_TABLE || 'orchestrator_observability_events';
}

function safeNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function authHeaders(cfg) {
  if (!cfg.user) return {};
  const token = Buffer.from(`${cfg.user}:${cfg.password}`).toString('base64');
  return { Authorization: `Basic ${token}` };
}

async function chFetch(url, { headers = {}, body, timeoutMs }) {
  if (typeof fetch !== 'function') throw new Error('fetch API недоступен в этой среде Node');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: ac.signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      const err = new Error(`ClickHouse ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      err.responseText = text;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

// Ошибка «нет таблицы/БД» — сигнал вызывающему, что нужно накатить схему и повторить.
export function isMissingSchemaError(error) {
  const t = `${error?.responseText || error?.message || ''}`.toLowerCase();
  return (
    t.includes('unknown_table') ||
    t.includes("doesn't exist") ||
    t.includes('does not exist') ||
    t.includes('unknown database') ||
    t.includes('unknown_database') ||
    t.includes('there is no table') ||
    t.includes('no column')
  );
}

// Выполнить произвольный SQL (DDL/DML/SELECT). По умолчанию НЕ привязываемся к БД
// (важно для CREATE DATABASE и полностью квалифицированных имён `orchestrator.tbl`).
export async function clickhouseCommand(sql, opts = {}) {
  const cfg = clickhouseConfig();
  const timeoutMs = safeNumber(opts.timeoutMs, safeNumber(process.env.CLICKHOUSE_DDL_TIMEOUT_MS, DEFAULT_DDL_TIMEOUT_MS));
  const params = new URLSearchParams();
  if (opts.database) params.set('database', opts.database);
  const url = `${cfg.baseUrl}/?${params.toString()}`;
  return chFetch(url, { headers: { 'Content-Type': 'text/plain', ...authHeaders(cfg) }, body: sql, timeoutMs });
}

// Пакетная вставка строк в формате JSONEachRow. async_insert по умолчанию —
// ClickHouse сам буферизует и не блокирует ответ (wait_for_async_insert=0).
export async function clickhouseInsertJSONEachRow(table, rows, opts = {}) {
  const cfg = clickhouseConfig();
  const timeoutMs = safeNumber(opts.timeoutMs, safeNumber(process.env.CLICKHOUSE_OBSERVABILITY_TIMEOUT_MS, DEFAULT_INSERT_TIMEOUT_MS));
  const params = new URLSearchParams({
    database: cfg.database,
    async_insert: process.env.CLICKHOUSE_ASYNC_INSERT ?? '1',
    wait_for_async_insert: process.env.CLICKHOUSE_WAIT_FOR_ASYNC_INSERT ?? '0',
    query: `INSERT INTO ${table} FORMAT JSONEachRow`,
  });
  const url = `${cfg.baseUrl}/?${params.toString()}`;
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await chFetch(url, { headers: { 'Content-Type': 'application/x-ndjson', ...authHeaders(cfg) }, body, timeoutMs });
  return { ok: true, rows: rows.length };
}
