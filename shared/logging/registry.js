// LOGGING-STANDARD-001 — реестр стабильных кодов событий и ошибок (§5, §15).
//
// event_code / error_code — машинные коды, НЕ зависящие от текста message.
// Реестр — единственный источник истины: он не даёт завести разные коды для одной
// ситуации и питает CI-проверку (validateRecord). Расширяется по мере надобности.
//
// Таксономия ошибок переиспользует оси разбора из потока observability
// (error_component/severity в orchestrator-service/backend/src/clickhouseObservability.js).

export const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
export const OPERATION_TYPES = ['inbound', 'outbound', 'internal', 'background'];
export const STATUSES = ['started', 'success', 'failed', 'skipped', 'timeout', 'cancelled'];
export const ERROR_TYPES = ['validation', 'authentication', 'authorization', 'not_found',
  'conflict', 'timeout', 'rate_limit', 'dependency', 'infrastructure', 'internal'];

// ── Каталог событий: code → { category, level, description } ────────────────────
export const EVENT_CODES = {
  // application.lifecycle
  APP_STARTED: { category: 'application.lifecycle', level: 'info', desc: 'Сервис поднялся и слушает порт' },
  APP_STOPPING: { category: 'application.lifecycle', level: 'info', desc: 'Плановая остановка (SIGTERM/SIGINT)' },
  APP_BOOT_STEP: { category: 'application.lifecycle', level: 'info', desc: 'Шаг инициализации (миграции, схема, реконсиляция)' },
  APP_BOOT_FAILED: { category: 'application.lifecycle', level: 'error', desc: 'Ошибка инициализации на старте' },
  // http.request
  HTTP_REQUEST_COMPLETED: { category: 'http.request', level: 'info', desc: 'HTTP-запрос обработан (доступ-лог)' },
  HTTP_REQUEST_FAILED: { category: 'http.request', level: 'error', desc: 'Необработанная ошибка в HTTP-обработчике' },
  HTTP_REQUEST_REJECTED: { category: 'http.request', level: 'warn', desc: 'Запрос отклонён (400/401/403/413)' },
  // dependency / external
  EXTERNAL_API_REQUEST: { category: 'external_api.request', level: 'debug', desc: 'Исходящий вызов внешней системы' },
  EXTERNAL_API_FAILED: { category: 'external_api.request', level: 'error', desc: 'Исходящий вызов завершился ошибкой' },
  DB_QUERY_FAILED: { category: 'database.query', level: 'error', desc: 'Запрос к БД завершился ошибкой' },
  // auth
  AUTH_LOGIN_SUCCESS: { category: 'authentication', level: 'info', desc: 'Успешная аутентификация' },
  AUTH_INVALID_CREDENTIALS: { category: 'authentication', level: 'warn', desc: 'Неверные учётные данные / токен' },
  AUTHZ_DENIED: { category: 'authorization', level: 'warn', desc: 'Доступ запрещён (нет прав)' },
  // background
  JOB_STARTED: { category: 'background_job', level: 'info', desc: 'Фоновая задача начата' },
  JOB_COMPLETED: { category: 'background_job', level: 'info', desc: 'Фоновая задача завершена успешно' },
  JOB_FAILED: { category: 'background_job', level: 'error', desc: 'Фоновая задача упала' },
  // observability self
  OBSERVABILITY_EXPORT_SKIPPED: { category: 'infrastructure', level: 'warn', desc: 'Экспорт в ClickHouse пропущен (best-effort)' },
};

// ── Каталог ошибок: error_code → метаданные для оператора (§6) ───────────────────
export const ERROR_CODES = {
  VALIDATION_FAILED: { type: 'validation', retryable: false, action_required: 'fix_input', operator_hint: 'Проверьте корректность входных данных запроса.' },
  UNAUTHORIZED: { type: 'authentication', retryable: false, action_required: 'check_token', operator_hint: 'Проверьте ORCHESTRATOR_API_TOKEN у вызывающего сервиса.' },
  FORBIDDEN: { type: 'authorization', retryable: false, action_required: 'check_permissions', operator_hint: 'Субъекту не хватает прав на операцию.' },
  NOT_FOUND: { type: 'not_found', retryable: false, action_required: null, operator_hint: null },
  PAYLOAD_TOO_LARGE: { type: 'validation', retryable: false, action_required: 'reduce_payload', operator_hint: 'Тело запроса превышает лимит сервиса.' },
  DB_QUERY_TIMEOUT: { type: 'timeout', retryable: true, action_required: 'check_db', operator_hint: 'Проверьте доступность и нагрузку Postgres (pg-main-rw).' },
  DB_UNAVAILABLE: { type: 'dependency', retryable: true, action_required: 'check_db', operator_hint: 'БД недоступна — проверьте кластер CNPG/Patroni.' },
  EXTERNAL_API_UNAVAILABLE: { type: 'dependency', retryable: true, action_required: 'check_dependency', operator_hint: 'Зависимый сервис недоступен — проверьте его health и сеть.' },
  EXTERNAL_API_TIMEOUT: { type: 'timeout', retryable: true, action_required: 'check_dependency', operator_hint: 'Таймаут исходящего вызова — проверьте латентность зависимости.' },
  RATE_LIMITED: { type: 'rate_limit', retryable: true, action_required: 'backoff', operator_hint: 'Достигнут лимит вызовов — включить backoff/повтор позже.' },
  INTERNAL_ERROR: { type: 'internal', retryable: false, action_required: 'investigate', operator_hint: 'Непредвиденная ошибка — смотрите stack_trace и trace_id.' },
};

export function isKnownEvent(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(EVENT_CODES, code);
}
export function isKnownError(code) {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(ERROR_CODES, code);
}

/** Метаданные ошибки из реестра (для авто-заполнения полей события). */
export function errorMeta(code) {
  return ERROR_CODES[code] || null;
}

/**
 * Проверка события на соответствие стандарту (§15). Возвращает массив нарушений
 * (пустой — событие валидно). Используется в тестах/CI/линтере, НЕ в горячем пути.
 */
export function validateRecord(rec, { strictRegistry = false } = {}) {
  const problems = [];
  if (!rec || typeof rec !== 'object') return ['record_not_object'];
  if (!rec.ts || Number.isNaN(Date.parse(rec.ts))) problems.push('invalid_or_missing_ts');
  if (!LEVELS.includes(rec.level)) problems.push('invalid_level');
  if (!rec.service) problems.push('missing_service');
  if (rec.message != null && String(rec.message).length > 16384) problems.push('message_too_long');
  if (rec.event_code != null && typeof rec.event_code !== 'string') problems.push('event_code_not_string');
  if (rec.status != null && !STATUSES.includes(rec.status)) problems.push('invalid_status');
  if (rec.duration_ms != null && !Number.isFinite(Number(rec.duration_ms))) problems.push('duration_ms_not_number');
  if (rec.error_type != null && !ERROR_TYPES.includes(rec.error_type)) problems.push('invalid_error_type');
  if (rec.retryable != null && typeof rec.retryable !== 'boolean') problems.push('retryable_not_boolean');
  if (strictRegistry) {
    if (rec.event_code && !isKnownEvent(rec.event_code)) problems.push(`unregistered_event_code:${rec.event_code}`);
    if (rec.error_code && !isKnownError(rec.error_code)) problems.push(`unregistered_error_code:${rec.error_code}`);
  }
  return problems;
}
