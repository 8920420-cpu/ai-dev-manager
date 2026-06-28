import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  classifyOutcome, nextLimitOnThrottle, nextLimitOnSuccess,
  acquire, recordResult, stats, tokensPerMinute, _resetForTest, LIMITS,
} = await import('../src/connectorLimiter.js');

test('classifyOutcome: 429/5xx/abort/сетевые → throttle, 4xx → error, 2xx → ok', () => {
  assert.equal(classifyOutcome({ httpStatus: 429 }), 'throttle');
  assert.equal(classifyOutcome({ httpStatus: 503 }), 'throttle');
  assert.equal(classifyOutcome({ aborted: true }), 'throttle');
  assert.equal(classifyOutcome({ errorMessage: 'fetch failed: ECONNRESET' }), 'throttle');
  assert.equal(classifyOutcome({ errorMessage: 'rate limit exceeded' }), 'throttle');
  assert.equal(classifyOutcome({ httpStatus: 400 }), 'error');
  assert.equal(classifyOutcome({ httpStatus: 200 }), 'ok');
});

test('keyed limiter: DeepSeek throttle does not reduce OpenAI bucket', () => {
  _resetForTest({ limit: 8 });
  recordResult({ key: 'deepseek', outcome: 'throttle', nowMs: 1000 });
  assert.equal(stats(1000, 'deepseek').limit, nextLimitOnThrottle(LIMITS.START, LIMITS.MIN));
  assert.equal(stats(1000, 'openai').limit, LIMITS.START);
});

test('AIMD: throttle делит лимит, success наращивает в пределах MIN/MAX', () => {
  assert.equal(nextLimitOnThrottle(8, 2), 4);
  assert.equal(nextLimitOnThrottle(3, 2), 2); // floor MIN
  assert.equal(nextLimitOnSuccess(6, 32), 7);
  assert.equal(nextLimitOnSuccess(32, 32), 32); // ceiling MAX
});

test('recordResult: троттлинг опускает текущий лимит синглтона', () => {
  _resetForTest({ limit: 8 });
  recordResult({ outcome: 'throttle', nowMs: 1000 });
  assert.equal(stats(1000).limit, 4);
});

test('подъём вверх только под насыщением (sawSaturation)', async () => {
  _resetForTest({ limit: LIMITS.MIN });
  // без насыщения серия успехов не поднимает лимит
  for (let i = 0; i < LIMITS.PROBE_AFTER + 5; i += 1) recordResult({ outcome: 'ok', nowMs: 1 });
  assert.equal(stats(1).limit, LIMITS.MIN);
});

test('acquire выдаёт слоты до лимита и ставит лишние в очередь', async () => {
  _resetForTest({ limit: 2 });
  const r1 = await acquire();
  const r2 = await acquire();
  assert.equal(stats().active, 2);
  assert.equal(stats().free, 0);
  assert.equal(stats().canSend, false);
  let third = false;
  const p3 = acquire().then((r) => { third = true; return r; });
  await Promise.resolve();
  assert.equal(third, false); // ждёт в очереди
  r1();
  const r3 = await p3;
  assert.equal(third, true);
  r2(); r3();
  assert.equal(stats().active, 0);
});

test('tokensPerMinute считает окно и нормирует в минуту', () => {
  _resetForTest({ limit: 6 });
  recordResult({ outcome: 'ok', totalTokens: 1000, nowMs: 10_000 });
  recordResult({ outcome: 'ok', totalTokens: 500, nowMs: 11_000 });
  // окно 60с по умолчанию → tpm = 1500 * 60000/60000 = 1500
  assert.equal(tokensPerMinute(12_000), 1500);
});
