// ORCH-BOOT-CLAIM-GRACE-001 — тесты гейта тишины по claim'ам после обрыва БД.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isDbConnectionError,
  noteDbConnectionFailure,
  claimGraceActive,
  __resetBootClaimGuard,
  __getLastFailureMsForTest,
} from '../src/bootClaimGuard.js';

test('isDbConnectionError ловит SQLSTATE connection-класса и failover', () => {
  for (const code of ['08006', '08P01', '57P01', '57P03', '25006']) {
    assert.equal(isDbConnectionError({ code }), true, `code ${code}`);
  }
});

test('isDbConnectionError ловит errno и текст обрыва сокета', () => {
  assert.equal(isDbConnectionError({ code: 'ECONNRESET' }), true);
  assert.equal(isDbConnectionError({ message: 'Connection terminated unexpectedly' }), true);
  assert.equal(isDbConnectionError({ message: 'terminating connection due to administrator command' }), true);
});

test('isDbConnectionError не реагирует на бизнес-ошибки и пустые значения', () => {
  assert.equal(isDbConnectionError({ code: '23505' }), false); // unique_violation
  assert.equal(isDbConnectionError({ message: 'syntax error at or near' }), false);
  assert.equal(isDbConnectionError(null), false);
  assert.equal(isDbConnectionError(undefined), false);
});

test('гейт неактивен без зафиксированных сбоев', () => {
  __resetBootClaimGuard();
  assert.equal(__getLastFailureMsForTest(), null);
  assert.equal(claimGraceActive(1000), false);
});

test('сбой включает окно, по истечении GRACE_MS гейт гаснет', () => {
  __resetBootClaimGuard();
  noteDbConnectionFailure(10_000);
  assert.equal(claimGraceActive(10_000, 15_000), true);
  assert.equal(claimGraceActive(24_999, 15_000), true); // внутри окна
  assert.equal(claimGraceActive(25_000, 15_000), false); // ровно на границе — уже нет
  assert.equal(claimGraceActive(30_000, 15_000), false); // далеко за окном
});

test('окно отсчитывается от самого позднего сбоя', () => {
  __resetBootClaimGuard();
  noteDbConnectionFailure(10_000);
  noteDbConnectionFailure(5_000); // более ранний сбой не сдвигает метку назад
  assert.equal(__getLastFailureMsForTest(), 10_000);
  noteDbConnectionFailure(20_000); // более поздний — продлевает окно
  assert.equal(__getLastFailureMsForTest(), 20_000);
});

test('graceMs=0 полностью выключает гейт', () => {
  __resetBootClaimGuard();
  noteDbConnectionFailure(10_000);
  assert.equal(claimGraceActive(10_000, 0), false);
});

test('noteDbConnectionFailure без аргумента не падает и фиксирует метку', () => {
  __resetBootClaimGuard();
  const t = noteDbConnectionFailure(); // дефолт — монотонные часы процесса
  assert.equal(Number.isFinite(t), true);
  assert.equal(__getLastFailureMsForTest(), t);
});
