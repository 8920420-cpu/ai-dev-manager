// LOGGING-STANDARD-001 — HTTP-обвязка корреляции и доступ-лога (§8).
//
// • извлекает/генерирует request_id/trace_id/span_id из входящих заголовков
//   (W3C traceparent или x-request-id/x-trace-id) — новый id создаётся ТОЛЬКО если
//   входящего нет/он невалиден;
// • прокидывает их в контекст (AsyncLocalStorage) на время обработки запроса;
// • возвращает клиенту x-request-id/traceresponse;
// • по завершении ответа пишет один структурный access-лог с методом/путём/
//   статусом/длительностью и уровнем по статусу.
//
// Транспортно-нейтрально: работает с голым node:http (req,res). НЕ навязывает express.

import { randomBytes } from 'node:crypto';
import { runWithContext } from './context.js';
import { redactHeaders } from './redact.js';

const HEX16 = /^[0-9a-f]{16}$/i;
const HEX32 = /^[0-9a-f]{32}$/i;

export function newTraceId() { return randomBytes(16).toString('hex'); }
export function newSpanId() { return randomBytes(8).toString('hex'); }
export function newRequestId() { return randomBytes(8).toString('hex'); }

/** Разобрать W3C traceparent: version-traceid-spanid-flags. */
export function parseTraceparent(value) {
  if (!value || typeof value !== 'string') return null;
  const p = value.trim().split('-');
  if (p.length < 4) return null;
  const [, traceId, spanId] = p;
  if (!HEX32.test(traceId) || /^0{32}$/.test(traceId)) return null;
  if (!HEX16.test(spanId) || /^0{16}$/.test(spanId)) return null;
  return { trace_id: traceId.toLowerCase(), parent_span_id: spanId.toLowerCase() };
}

/**
 * Собрать correlation-контекст из входящего запроса. Новый id создаётся только при
 * отсутствии/невалидности входящего (§8).
 */
export function extractCorrelation(req) {
  const h = req.headers || {};
  const tp = parseTraceparent(h.traceparent);
  const trace_id = tp?.trace_id
    || (HEX32.test(String(h['x-trace-id'] || '')) ? String(h['x-trace-id']).toLowerCase() : newTraceId());
  const parent_span_id = tp?.parent_span_id || (HEX16.test(String(h['x-parent-span-id'] || '')) ? String(h['x-parent-span-id']).toLowerCase() : undefined);
  const request_id = (h['x-request-id'] && String(h['x-request-id']).slice(0, 128)) || newRequestId();
  const correlation_id = (h['x-correlation-id'] && String(h['x-correlation-id']).slice(0, 128)) || request_id;
  return { request_id, correlation_id, trace_id, span_id: newSpanId(), parent_span_id };
}

/** Заголовки исходящего запроса для проброса корреляции в зависимости (§8). */
export function propagationHeaders(ctx) {
  if (!ctx) return {};
  const out = {};
  if (ctx.request_id) out['x-request-id'] = ctx.request_id;
  if (ctx.correlation_id) out['x-correlation-id'] = ctx.correlation_id;
  if (ctx.trace_id && ctx.span_id) out.traceparent = `00-${ctx.trace_id}-${ctx.span_id}-01`;
  return out;
}

function statusLevel(status) {
  if (status >= 500) return 'error';
  if (status >= 400) return 'warn';
  return 'info';
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

/**
 * Обернуть node:http-обработчик в корреляцию + access-лог.
 *   const handler = withHttpLogging(logger, (req,res)=>{...}, { routeOf });
 *   createServer(handler)
 * routeOf(req) — опциональная нормализация пути в шаблон маршрута (низкая
 * кардинальность: /api/projects/:id вместо конкретного uuid).
 */
export function withHttpLogging(logger, handler, opts = {}) {
  const routeOf = opts.routeOf || ((req) => (req.url || '/').split('?')[0]);
  const isHealth = opts.isHealthPath || (() => false);
  return function wrapped(req, res) {
    const ctx = extractCorrelation(req);
    const start = nowMs();
    res.setHeader('x-request-id', ctx.request_id);
    if (ctx.trace_id && ctx.span_id) res.setHeader('traceresponse', `00-${ctx.trace_id}-${ctx.span_id}-01`);

    return runWithContext(ctx, () => {
      let logged = false;
      const finalize = () => {
        if (logged) return;
        logged = true;
        const route = routeOf(req);
        if (isHealth(route)) return; // health/probes не шумят (§10)
        const status = res.statusCode || 0;
        const level = statusLevel(status);
        logger[level]('http request', {
          event_code: status >= 500 ? 'HTTP_REQUEST_FAILED' : status >= 400 ? 'HTTP_REQUEST_REJECTED' : 'HTTP_REQUEST_COMPLETED',
          event_category: 'http.request',
          operation: `${req.method} ${route}`,
          operation_type: 'inbound',
          protocol: 'http',
          method: req.method,
          route,
          status: status >= 400 ? 'failed' : 'success',
          status_code: status,
          duration_ms: nowMs() - start,
          headers: redactHeaders(req.headers),
        });
      };
      res.on('finish', finalize);
      res.on('close', finalize);
      return handler(req, res);
    });
  };
}
