// LOGGING-STANDARD-001 — структурный логгер без внешних зависимостей.
//
// Production-формат: одна строка = один JSON-объект в stdout (stderr для error/fatal),
// что напрямую подхватывает Fluent Bit → ClickHouse (k8s.app_logs). Локально
// (LOG_PRETTY=1 или TTY вне production) — человекочитаемый формат.
//
// Ключевое:
//   • уровни trace/debug/info/warn/error/fatal с гейтом по LOG_LEVEL;
//   • correlation-поля (request_id/trace_id/...) автоматически из context.js;
//   • Error сериализуется в error_type/error_message/stack_trace (без ручной склейки);
//   • секреты маскируются redact() перед выводом;
//   • event_code/error_code — стабильные коды (реестр registry.js).
//
// API:
//   const log = createLogger({ service: 'orchestrator-service' });
//   log.info('http request completed', { event_code:'HTTP_REQUEST_COMPLETED', duration_ms:12 });
//   log.error('order create failed', { event_code:'ORDER_CREATE_FAILED', err });
//   const child = log.child({ operation:'order.create' });

import { contextFields } from './context.js';
import { redact } from './redact.js';
import { errorMeta } from './registry.js';

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

function thresholdFor(env) {
  return LEVELS[String(env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}

function serializeError(err) {
  if (!(err instanceof Error)) {
    if (err && typeof err === 'object') return { error_message: err.message || String(err.error || '') };
    return err == null ? {} : { error_message: String(err) };
  }
  const out = {
    error_type: err.type || undefined,
    error_code: err.code && typeof err.code === 'string' ? err.code : undefined,
    error_message: err.message,
    error_name: err.name,
    stack_trace: err.stack,
  };
  if (err.cause instanceof Error) out.error_cause = err.cause.message;
  return out;
}

function levelOf(v) {
  return LEVELS[v] || LEVELS.info;
}

function prettyLine(rec) {
  const { ts, level, service, message, event_code, ...rest } = rec;
  const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  const code = event_code ? ` (${event_code})` : '';
  return `${ts} ${String(level).toUpperCase().padEnd(5)} [${service}]${code} ${message ?? ''}${extra}`;
}

/**
 * Создать логгер, привязанный к сервису.
 * opts: { service, version, environment, env, stream, bindings }
 */
export function createLogger(opts = {}) {
  const env = opts.env || process.env;
  const service = opts.service || env.SERVICE_NAME || 'unknown';
  const base = {
    service,
    service_version: opts.version || env.SERVICE_VERSION || env.APP_CODE_VERSION || undefined,
    env: opts.environment || env.APP_ENV || env.NODE_ENV || 'production',
  };
  const bindings = opts.bindings || {};
  const threshold = thresholdFor(env);
  const pretty = env.LOG_PRETTY === '1'
    || (env.LOG_PRETTY !== '0' && !!process.stdout.isTTY && env.NODE_ENV !== 'production');
  const maxMessage = Number(env.LOG_MAX_MESSAGE || 8192);
  const write = opts.write || ((line, isErr) => (isErr ? process.stderr : process.stdout).write(`${line}\n`));

  function emit(level, arg1, arg2) {
    if (levelOf(level) < threshold) return;
    let message;
    let fields;
    if (typeof arg1 === 'string') {
      message = arg1;
      fields = arg2 && typeof arg2 === 'object' ? { ...arg2 } : {};
    } else {
      fields = arg1 && typeof arg1 === 'object' ? { ...arg1 } : {};
      message = fields.message || fields.msg || '';
    }
    delete fields.message;
    delete fields.msg;

    const err = fields.err || fields.error;
    delete fields.err;
    delete fields.error;

    const record = {
      ts: new Date().toISOString(),
      level,
      ...base,
      message: message == null ? '' : String(message).slice(0, maxMessage),
      ...bindings,
      ...contextFields(),
      ...fields,
    };

    if (err != null) Object.assign(record, serializeError(err));

    // Автозаполнение из реестра ошибок: type/retryable/action_required/operator_hint,
    // если error_code известен и поле ещё не задано вручную.
    if (record.error_code) {
      const meta = errorMeta(record.error_code);
      if (meta) {
        if (record.error_type == null) record.error_type = meta.type;
        if (record.retryable == null && meta.retryable != null) record.retryable = meta.retryable;
        if (record.action_required == null && meta.action_required) record.action_required = meta.action_required;
        if (record.operator_hint == null && meta.operator_hint) record.operator_hint = meta.operator_hint;
      }
    }

    const safe = redact(record, { maxStringLen: maxMessage });
    write(pretty ? prettyLine(safe) : JSON.stringify(safe), levelOf(level) >= LEVELS.error);
  }

  const logger = {};
  for (const name of Object.keys(LEVELS)) logger[name] = (a, b) => emit(name, a, b);
  logger.log = emit;
  logger.child = (extra = {}) => createLogger({ ...opts, env, bindings: { ...bindings, ...extra } });
  logger.service = service;
  return logger;
}

// Ленивый общий логгер по умолчанию (SERVICE_NAME из env). Сервисы обычно создают
// свой явный createLogger({service}), но default удобен для утилит.
let _default;
export function defaultLogger() {
  if (!_default) _default = createLogger();
  return _default;
}
