// PERFORMANCE-MONITOR-001 — тесты чистого расчёта производных KPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveKpi } from '../src/performance.js';

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
