import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, resolveDuration, resolveInt, logEffectiveConfig } from '../src/envConfig.js';

test('parseDurationMs: число=ms, единицы не путаются, мусор=NaN', () => {
  assert.equal(parseDurationMs('600000'), 600_000);
  assert.equal(parseDurationMs('540s'), 540_000);
  assert.equal(parseDurationMs('9m'), 540_000);
  assert.equal(parseDurationMs(''), null);
  assert.ok(Number.isNaN(parseDurationMs('abc')));
});

test('resolveDuration: дефолт без env, env при наличии', () => {
  assert.equal(resolveDuration('T', 600_000, { env: {} }).source, 'default');
  const r = resolveDuration('T', 600_000, { env: { T: '540000' } });
  assert.equal(r.value, 540_000);
  assert.equal(r.source, 'env');
});

test('resolveDuration: некорректный env → безопасный дефолт (не NaN/0)', () => {
  const r = resolveDuration('T', 600_000, { env: { T: 'abc' } });
  assert.equal(r.value, 600_000);
  assert.ok(r.warning);
});

test('resolveInt: диапазон и мусор', () => {
  assert.equal(resolveInt('C', 2, { env: { C: '4' }, min: 1, max: 8 }).value, 4);
  assert.equal(resolveInt('C', 2, { env: { C: '99' }, min: 1, max: 8 }).value, 2);
});

test('logEffectiveConfig: формат и предупреждения', () => {
  const warns = []; const logs = [];
  const eff = logEffectiveConfig('codex-runner', [
    resolveDuration('A_MS', 5000, { env: { A_MS: '7000' } }),
    resolveDuration('B_MS', 5000, { env: { B_MS: 'oops' } }),
  ], { warn: (m) => warns.push(m), log: (m) => logs.push(m) });
  assert.equal(eff.A_MS.source, 'env');
  assert.equal(eff.B_MS.source, 'default');
  assert.equal(warns.length, 1);
  assert.ok(logs[0].includes('effectiveConfig='));
});
