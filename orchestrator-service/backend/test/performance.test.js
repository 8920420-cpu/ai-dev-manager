// PERFORMANCE-MONITOR-001 — тесты чистого расчёта производных KPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKpi, deriveVersionDeltas } from '../src/performance.js';

test('deriveKpi: базовые агрегаты по статусам', () => {
  const k = deriveKpi({
    byStatus: { BACKLOG: 2, CODING: 3, DONE: 5, CANCELLED: 1, FAILED: 2, BLOCKED: 1 },
  });
  assert.equal(k.total, 14);
  assert.equal(k.done, 5);
  assert.equal(k.completed, 6); // DONE + CANCELLED
  assert.equal(k.failed, 2);
  assert.equal(k.blocked, 1);
  // active = total - (done+cancelled+failed) - blocked = 14 - 8 - 1 = 5
  assert.equal(k.active, 5);
});

test('deriveKpi: retryRate = лишние входы / все переходы', () => {
  const k = deriveKpi({ byStatus: { DONE: 1 }, transitions: 10, reworkExtra: 3 });
  assert.equal(k.transitions, 10);
  assert.equal(k.reworkExtra, 3);
  assert.equal(k.retryRate, 0.3);
});

test('deriveKpi: нет переходов → retryRate 0, без деления на ноль', () => {
  const k = deriveKpi({ byStatus: {}, transitions: 0, reworkExtra: 0 });
  assert.equal(k.retryRate, 0);
  assert.equal(k.total, 0);
  assert.equal(k.active, 0);
});

test('deriveKpi: пустой ввод не падает', () => {
  const k = deriveKpi();
  assert.equal(k.total, 0);
  assert.equal(k.retryRate, 0);
});

// VERSION-KPI-TRACKING-001 — дельты и регресс по версиям.

test('deriveVersionDeltas: первая версия без дельт; вторая — дельта к первой', () => {
  const rows = [
    { n: 10, avgDurationMs: 5000, avgTokensIn: 3000, avgTokensOut: 1000, avgCost: null, avgColdStartMs: null, avgTurns: null, avgPasses: null, successRate: 1 },
    { n: 10, avgDurationMs: 4500, avgTokensIn: 2000, avgTokensOut: 1000, avgCost: null, avgColdStartMs: null, avgTurns: null, avgPasses: null, successRate: 1 },
  ];
  const out = deriveVersionDeltas(rows);
  // Первая — нет предыдущей: дельты null.
  assert.equal(out[0].delta.avgDurationMs, null);
  assert.equal(out[0].enoughData, false);
  // Вторая: время −500мс (улучшение), токены вх −1000.
  assert.equal(out[1].delta.avgDurationMs.abs, -500);
  assert.equal(out[1].delta.avgTokensIn.abs, -1000);
  // Улучшение «чем меньше тем лучше» → не регресс.
  assert.equal(out[1].regression, false);
});

test('deriveVersionDeltas: рост времени >10% при выборке ≥5 → регресс', () => {
  const rows = [
    { n: 8, avgDurationMs: 4000, successRate: 1 },
    { n: 8, avgDurationMs: 4800, successRate: 1 }, // +20%
  ];
  const out = deriveVersionDeltas(rows);
  assert.equal(out[1].enoughData, true);
  assert.equal(out[1].regression, true);
  assert.ok(out[1].regressedMetrics.includes('avgDurationMs'));
});

test('deriveVersionDeltas: рост при малой выборке не помечается регрессом', () => {
  const rows = [
    { n: 2, avgDurationMs: 4000, successRate: 1 },
    { n: 2, avgDurationMs: 6000, successRate: 1 }, // +50%, но n<5
  ];
  const out = deriveVersionDeltas(rows);
  assert.equal(out[1].enoughData, false);
  assert.equal(out[1].regression, false);
  // Дельта всё равно посчитана (для отображения), просто не «значима».
  assert.equal(out[1].delta.avgDurationMs.abs, 2000);
});

test('deriveVersionDeltas: падение successRate >10% → регресс (higher-is-better)', () => {
  const rows = [
    { n: 10, successRate: 1.0, avgDurationMs: 1000 },
    { n: 10, successRate: 0.8, avgDurationMs: 1000 }, // −20% успеха
  ];
  const out = deriveVersionDeltas(rows);
  assert.equal(out[1].regression, true);
  assert.ok(out[1].regressedMetrics.includes('successRate'));
});

test('deriveVersionDeltas: пустой и одиночный списки не падают', () => {
  assert.deepEqual(deriveVersionDeltas([]), []);
  const one = deriveVersionDeltas([{ n: 3, avgDurationMs: 100, successRate: 1 }]);
  assert.equal(one.length, 1);
  assert.equal(one[0].regression, false);
});
