// LOGGING-STANDARD-001 — контекст корреляции запроса поверх AsyncLocalStorage.
//
// Хранит per-request идентификаторы (request_id/trace_id/span_id/correlation_id/
// tenant_id/user_id и произвольные бизнес-поля), которые логгер автоматически
// подмешивает в каждое событие внутри запроса — без ручного проброса по слоям.
//
// Использование:
//   runWithContext({ request_id, trace_id }, () => handler(req, res));
//   bindContext({ tenant_id });      // дополнить текущий контекст по ходу
//   getContext();                    // прочитать (undefined вне запроса)
import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

// Поля, которые логгер наследует из контекста в каждое событие (correlation-ядро).
export const CONTEXT_FIELDS = [
  'request_id',
  'correlation_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'tenant_id',
  'user_id',
  'session_id',
];

/** Запустить fn в новом контексте корреляции (наследует поля из ctx). */
export function runWithContext(ctx, fn) {
  return storage.run({ ...(ctx || {}) }, fn);
}

/** Текущий контекст (undefined вне runWithContext). */
export function getContext() {
  return storage.getStore();
}

/** Дополнить текущий контекст (no-op вне запроса — не бросает). */
export function bindContext(patch) {
  const store = storage.getStore();
  if (store && patch) Object.assign(store, patch);
  return store;
}

/** Только correlation-поля из контекста (для подмешивания в событие). */
export function contextFields() {
  const store = storage.getStore();
  if (!store) return {};
  const out = {};
  for (const key of CONTEXT_FIELDS) {
    if (store[key] != null && store[key] !== '') out[key] = store[key];
  }
  // Бизнес-поля, явно положенные в контекст (entity_id, operation и т.п.).
  if (store.attributes && typeof store.attributes === 'object') out.attributes = store.attributes;
  return out;
}

export const __storage = storage; // для тестов
