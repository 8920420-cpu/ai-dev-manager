// LOGGING-STANDARD-001 — единая точка импорта логгера.
//   import { createLogger, withHttpLogging, runWithContext } from '../../shared/logging/index.js';
export { createLogger, defaultLogger } from './logger.js';
export { runWithContext, getContext, bindContext, contextFields, CONTEXT_FIELDS } from './context.js';
export {
  withHttpLogging, extractCorrelation, propagationHeaders,
  parseTraceparent, newTraceId, newSpanId, newRequestId,
} from './http.js';
export { redact, redactHeaders, redactString, isSecretKey, SECRET_KEYS } from './redact.js';
export {
  EVENT_CODES, ERROR_CODES, LEVELS, STATUSES, ERROR_TYPES,
  isKnownEvent, isKnownError, errorMeta, validateRecord,
} from './registry.js';
