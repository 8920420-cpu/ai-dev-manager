import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTokenBucket,
  createLimiterRegistry,
  createMetrics,
  rateLimitMiddleware,
  resolveLimit,
  DEFAULT_LIMITS,
} from '../limiter.js';

// Управляемое время для детерминизма.
function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test('token bucket: пропускает в пределах ёмкости', () => {
  const clk = fakeClock();
  const b = createTokenBucket({ capacity: 3, refillPerSec: 0, now: clk.now });
  assert.equal(b.tryRemove().allowed, true);
  assert.equal(b.tryRemove().allowed, true);
  assert.equal(b.tryRemove().allowed, true);
  const blocked = b.tryRemove();
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.retryAfterMs, Infinity); // refill=0 => никогда без пополнения
});

test('token bucket: пополняется со временем', () => {
  const clk = fakeClock();
  const b = createTokenBucket({ capacity: 2, refillPerSec: 1, now: clk.now });
  b.tryRemove(); b.tryRemove();
  assert.equal(b.tryRemove().allowed, false);
  clk.advance(1000); // +1 токен
  assert.equal(b.tryRemove().allowed, true);
  assert.equal(b.tryRemove().allowed, false);
});

test('token bucket: retryAfterMs считает дефицит', () => {
  const clk = fakeClock();
  const b = createTokenBucket({ capacity: 1, refillPerSec: 2, now: clk.now });
  b.tryRemove();
  const v = b.tryRemove();
  assert.equal(v.allowed, false);
  assert.equal(v.retryAfterMs, 500); // 1 токен при 2/сек = 500мс
});

test('registry: раздельные вёдра по клиенту и классу', () => {
  const clk = fakeClock();
  const reg = createLimiterRegistry({ limits: { anonymous: { capacity: 1, refillPerSec: 0 } }, now: clk.now });
  assert.equal(reg.bucketFor('ip1', 'anonymous').tryRemove().allowed, true);
  assert.equal(reg.bucketFor('ip1', 'anonymous').tryRemove().allowed, false);
  assert.equal(reg.bucketFor('ip2', 'anonymous').tryRemove().allowed, true); // другой клиент — своё ведро
  assert.equal(reg.size(), 2);
});

test('resolveLimit: дефолты anonymous/authenticated', () => {
  assert.equal(resolveLimit(DEFAULT_LIMITS, 'authenticated').capacity, 120);
  assert.equal(resolveLimit(DEFAULT_LIMITS, 'anonymous').capacity, 30);
  assert.equal(resolveLimit(DEFAULT_LIMITS, 'unknown').capacity, 30); // фолбэк на anonymous
});

// Минимальные подделки res для middleware.
function fakeRes() {
  const res = { headers: {}, statusCode: 200, body: null };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('middleware: пропускает и считает allowed; ставит заголовки', () => {
  const clk = fakeClock();
  const metrics = createMetrics();
  const mw = rateLimitMiddleware({ limits: { anonymous: { capacity: 2, refillPerSec: 0 } }, now: clk.now, metrics });
  let nexted = 0;
  const next = () => { nexted += 1; };
  const res = fakeRes();
  mw({ ip: '1.1.1.1', headers: {} }, res, next);
  assert.equal(nexted, 1);
  assert.equal(res.headers['X-RateLimit-Limit'], '2');
  assert.equal(metrics.snapshot().allowed, 1);
});

test('middleware: блокирует сверх лимита с 429 и Retry-After', () => {
  const clk = fakeClock();
  const mw = rateLimitMiddleware({ limits: { anonymous: { capacity: 1, refillPerSec: 1 } }, now: clk.now });
  const next = () => {};
  mw({ ip: '2.2.2.2', headers: {} }, fakeRes(), next); // первый — ок
  const res = fakeRes();
  mw({ ip: '2.2.2.2', headers: {} }, res, next); // второй — блок
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.error, 'rate_limited');
  assert.ok(Number(res.headers['Retry-After']) >= 1);
  assert.equal(mw.metrics.snapshot().blocked, 1);
});

test('middleware: авторизованный получает более высокий класс лимита', () => {
  const clk = fakeClock();
  const mw = rateLimitMiddleware({ now: clk.now });
  const res = fakeRes();
  mw({ ip: '3.3.3.3', headers: { authorization: 'Bearer x' } }, res, () => {});
  assert.equal(res.headers['X-RateLimit-Limit'], String(DEFAULT_LIMITS.authenticated.capacity));
});
