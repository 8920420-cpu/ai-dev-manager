// LOGGING-STANDARD-001 — тесты общего структурного логгера (shared/logging).
// Запускается общим `node --test` бэкенда (входит в npm run test:services).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLogger, runWithContext, bindContext,
  redact, redactHeaders, isSecretKey,
  parseTraceparent, extractCorrelation, propagationHeaders,
  validateRecord, isKnownError,
} from '../../../shared/logging/index.js';

// Логгер с перехватом вывода (JSON-режим форсируем через env).
function capturingLogger(extra = {}) {
  const lines = [];
  const log = createLogger({
    service: 'test-service',
    env: { LOG_LEVEL: 'trace', LOG_PRETTY: '0', NODE_ENV: 'production', ...extra },
    write: (line, isErr) => lines.push({ rec: JSON.parse(line), isErr }),
  });
  return { log, lines };
}

test('эмитит одну строку валидного JSON с обязательными полями', () => {
  const { log, lines } = capturingLogger();
  log.info('hello', { event_code: 'APP_STARTED' });
  assert.equal(lines.length, 1);
  const r = lines[0].rec;
  assert.equal(r.service, 'test-service');
  assert.equal(r.level, 'info');
  assert.equal(r.message, 'hello');
  assert.equal(r.event_code, 'APP_STARTED');
  assert.ok(!Number.isNaN(Date.parse(r.ts)));
  assert.equal(validateRecord(r).length, 0);
});

test('уровни: LOG_LEVEL=warn подавляет info/debug', () => {
  const { log, lines } = capturingLogger({ LOG_LEVEL: 'warn' });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(lines.map((l) => l.rec.level), ['warn', 'error']);
});

test('error/fatal идут в stderr, остальное в stdout', () => {
  const { log, lines } = capturingLogger();
  log.info('i');
  log.error('e');
  assert.equal(lines[0].isErr, false);
  assert.equal(lines[1].isErr, true);
});

test('маскирует секреты (по ключу и вложенно)', () => {
  const { log, lines } = capturingLogger();
  log.info('req', { password: 'p@ss', authorization: 'Bearer xyz', nested: { api_key: 'k', ok: 'visible' } });
  const r = lines[0].rec;
  assert.equal(r.password, '[REDACTED]');
  assert.equal(r.authorization, '[REDACTED]');
  assert.equal(r.nested.api_key, '[REDACTED]');
  assert.equal(r.nested.ok, 'visible');
});

test('redact() маскирует Bearer/пароль в свободном тексте message', () => {
  const out = redact({ message: 'auth Bearer abcdef123456 and password=secret123' });
  assert.match(out.message, /\[REDACTED\]/);
  assert.doesNotMatch(out.message, /abcdef123456/);
});

test('isSecretKey нормализует регистр и разделители', () => {
  assert.ok(isSecretKey('Access-Token'));
  assert.ok(isSecretKey('X_API_TOKEN'));
  assert.ok(!isSecretKey('username'));
});

test('redactHeaders: allowlist + маскирование authorization/cookie', () => {
  const h = redactHeaders({ authorization: 'Bearer x', cookie: 'a=b', 'user-agent': 'curl', 'x-secret': 'nope' });
  assert.equal(h.authorization, '[REDACTED]');
  assert.equal(h.cookie, '[REDACTED]');
  assert.equal(h['user-agent'], 'curl');
  assert.equal(h['x-secret'], undefined); // не в allowlist → опущен
});

test('сериализация Error → error_message/stack_trace + автозаполнение из реестра', () => {
  const { log, lines } = capturingLogger();
  const e = new Error('boom');
  e.code = 'DB_QUERY_TIMEOUT';
  log.error('failed', { err: e });
  const r = lines[0].rec;
  assert.equal(r.error_message, 'boom');
  assert.ok(r.stack_trace.includes('boom'));
  assert.equal(r.error_code, 'DB_QUERY_TIMEOUT');
  assert.equal(r.error_type, 'timeout');      // из реестра
  assert.equal(r.retryable, true);            // из реестра
  assert.ok(r.operator_hint);                 // из реестра
});

test('контекст корреляции наследуется в событие', () => {
  const { log, lines } = capturingLogger();
  runWithContext({ request_id: 'r1', trace_id: 'a'.repeat(32) }, () => {
    bindContext({ tenant_id: 't1' });
    log.info('inside');
  });
  const r = lines[0].rec;
  assert.equal(r.request_id, 'r1');
  assert.equal(r.trace_id, 'a'.repeat(32));
  assert.equal(r.tenant_id, 't1');
});

test('parseTraceparent: валидный/невалидный', () => {
  const ok = parseTraceparent('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01');
  assert.equal(ok.trace_id, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(ok.parent_span_id, 'b7ad6b7169203331');
  assert.equal(parseTraceparent('garbage'), null);
  assert.equal(parseTraceparent('00-' + '0'.repeat(32) + '-b7ad6b7169203331-01'), null); // нулевой trace
});

test('extractCorrelation: берёт входящие id, генерит при отсутствии', () => {
  const withHeaders = extractCorrelation({ headers: {
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    'x-request-id': 'req-abc',
  } });
  assert.equal(withHeaders.trace_id, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(withHeaders.request_id, 'req-abc');
  assert.equal(withHeaders.correlation_id, 'req-abc'); // fallback = request_id

  const generated = extractCorrelation({ headers: {} });
  assert.match(generated.trace_id, /^[0-9a-f]{32}$/);
  assert.match(generated.span_id, /^[0-9a-f]{16}$/);
  assert.ok(generated.request_id);
});

test('propagationHeaders формирует W3C traceparent для исходящих', () => {
  const h = propagationHeaders({ request_id: 'r', correlation_id: 'c', trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) });
  assert.equal(h['x-request-id'], 'r');
  assert.equal(h.traceparent, `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
});

test('validateRecord ловит нарушения стандарта', () => {
  assert.deepEqual(validateRecord({ ts: 'x', level: 'nope', message: 'm' }).sort(),
    ['invalid_level', 'invalid_or_missing_ts', 'missing_service'].sort());
  assert.ok(validateRecord({ ts: new Date().toISOString(), level: 'info', service: 's', status: 'weird' })
    .includes('invalid_status'));
  assert.ok(isKnownError('INTERNAL_ERROR'));
});

test('strictRegistry помечает незарегистрированные коды', () => {
  const problems = validateRecord(
    { ts: new Date().toISOString(), level: 'info', service: 's', event_code: 'NOT_REGISTERED' },
    { strictRegistry: true },
  );
  assert.ok(problems.some((p) => p.startsWith('unregistered_event_code')));
});
