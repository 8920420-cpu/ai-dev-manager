import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDurationMs, resolveDuration, resolveInt, logEffectiveConfig } from '../src/envConfig.js';

test('parseDurationMs: голое число трактуется как ms', () => {
  assert.equal(parseDurationMs('600000'), 600000);
  assert.equal(parseDurationMs('0'), 0);
});

test('parseDurationMs: единицы измерения не путаются', () => {
  assert.equal(parseDurationMs('540s'), 540_000);
  assert.equal(parseDurationMs('9m'), 540_000);
  assert.equal(parseDurationMs('9min'), 540_000);
  assert.equal(parseDurationMs('1h'), 3_600_000);
  assert.equal(parseDurationMs('600000ms'), 600_000);
});

test('parseDurationMs: пусто → null, мусор → NaN (а не 0)', () => {
  assert.equal(parseDurationMs(undefined), null);
  assert.equal(parseDurationMs(''), null);
  assert.ok(Number.isNaN(parseDurationMs('abc')));
  assert.ok(Number.isNaN(parseDurationMs('10x')));
});

test('resolveDuration: без env используется дефолт', () => {
  const r = resolveDuration('X_TIMEOUT_MS', 600_000, { env: {} });
  assert.equal(r.value, 600_000);
  assert.equal(r.source, 'default');
  assert.equal(r.warning, null);
});

test('resolveDuration: с env используется env (с единицами)', () => {
  const r = resolveDuration('X_TIMEOUT_MS', 600_000, { env: { X_TIMEOUT_MS: '9m' } });
  assert.equal(r.value, 540_000);
  assert.equal(r.source, 'env');
  assert.equal(r.raw, '9m');
});

test('resolveDuration: некорректный env → безопасный дефолт + предупреждение (не NaN/0)', () => {
  const r = resolveDuration('X_TIMEOUT_MS', 600_000, { env: { X_TIMEOUT_MS: 'abc' } });
  assert.equal(r.value, 600_000);
  assert.equal(r.source, 'default');
  assert.ok(r.warning && r.warning.includes('некорректное'));
});

test('resolveDuration: выход за диапазон → дефолт + предупреждение', () => {
  const r = resolveDuration('X_TIMEOUT_MS', 600_000, { env: { X_TIMEOUT_MS: '10' }, min: 30_000 });
  assert.equal(r.value, 600_000);
  assert.equal(r.source, 'default');
  assert.ok(r.warning && r.warning.includes('диапазона'));
});

test('resolveInt: дефолт / env / мусор', () => {
  assert.equal(resolveInt('C', 2, { env: {} }).value, 2);
  assert.equal(resolveInt('C', 2, { env: { C: '1' }, min: 1, max: 8 }).value, 1);
  const bad = resolveInt('C', 2, { env: { C: '1.5' } });
  assert.equal(bad.value, 2);
  assert.equal(bad.source, 'default');
});

test('logEffectiveConfig: собирает {value,source,envName,defaultValue} и пишет предупреждения', () => {
  const warns = [];
  const logs = [];
  const fakeLog = { warn: (m) => warns.push(m), log: (m) => logs.push(m) };
  const entries = [
    resolveDuration('A_MS', 5000, { env: { A_MS: '7000' } }),
    resolveDuration('B_MS', 5000, { env: { B_MS: 'oops' } }),
  ];
  const eff = logEffectiveConfig('test-runner', entries, fakeLog);
  assert.equal(eff.A_MS.value, 7000);
  assert.equal(eff.A_MS.source, 'env');
  assert.equal(eff.A_MS.envName, 'A_MS');
  assert.equal(eff.A_MS.defaultValue, 5000);
  assert.equal(eff.B_MS.value, 5000);
  assert.equal(eff.B_MS.source, 'default');
  assert.equal(warns.length, 1);
  assert.equal(logs.length, 1);
  assert.ok(logs[0].includes('effectiveConfig='));
});
