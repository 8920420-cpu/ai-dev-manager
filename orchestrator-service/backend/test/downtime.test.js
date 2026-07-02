// ORCH-DOWNTIME-MARKER-001 — чистое решение «был ли простой оркестратора».
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDowntime } from '../src/performance.js';

test('нет last_seen (первый старт) → простоя нет', () => {
  const r = computeDowntime(null, '2026-07-02T17:00:00Z', 600000);
  assert.equal(r.downtime, false);
  assert.equal(r.ref, null);
});

test('короткая пауза (< порога) → простоя нет', () => {
  const r = computeDowntime('2026-07-02T17:00:00Z', '2026-07-02T17:05:00Z', 600000);
  assert.equal(r.downtime, false);
});

test('долгий разрыв (> порога) → простой с ref и часами', () => {
  const r = computeDowntime('2026-06-29T18:20:19Z', '2026-07-02T17:05:18Z', 600000);
  assert.equal(r.downtime, true);
  assert.equal(r.ref, '2026-06-29T18:20:19.000Z..2026-07-02T17:05:18.000Z');
  assert.ok(r.hours > 70 && r.hours < 72, `часы простоя: ${r.hours}`);
});

test('одинаковый интервал даёт одинаковый ref (идемпотентность метки)', () => {
  const a = computeDowntime('2026-06-29T18:20:19Z', '2026-07-02T17:05:18Z');
  const b = computeDowntime('2026-06-29T18:20:19.000Z', '2026-07-02T17:05:18.000Z');
  assert.equal(a.ref, b.ref);
});

test('битые даты → простоя нет (не падает)', () => {
  assert.equal(computeDowntime('not-a-date', '2026-07-02T17:00:00Z').downtime, false);
});
