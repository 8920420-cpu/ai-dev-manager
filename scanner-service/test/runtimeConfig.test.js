import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveScannerRuntime,
  ScannerModeError,
} from '../src/runtimeConfig.js';

// --- Выбор режима по новому контракту ---------------------------------------

test('api-режим: SCANNER_API_BASE задаёт mode=api и базу оркестратора (срез хвостового /)', () => {
  const rt = resolveScannerRuntime({ SCANNER_API_BASE: 'http://orchestrator/' });
  assert.equal(rt.mode, 'api');
  assert.equal(rt.apiBase, 'http://orchestrator');
  assert.equal(rt.orchestratorBase, 'http://orchestrator');
});

test('snapshot-режим: SCANNER_SNAPSHOT + ORCHESTRATOR_API_BASE → mode=snapshot', () => {
  const rt = resolveScannerRuntime({
    SCANNER_SNAPSHOT: '/cfg/snapshot.json',
    ORCHESTRATOR_API_BASE: 'http://orchestrator',
  });
  assert.equal(rt.mode, 'snapshot');
  assert.equal(rt.snapshot, '/cfg/snapshot.json');
  assert.equal(rt.orchestratorBase, 'http://orchestrator');
});

// --- Граничные условия ------------------------------------------------------

test('snapshot без ORCHESTRATOR_API_BASE → ScannerModeError (некуда слать результаты)', () => {
  assert.throws(
    () => resolveScannerRuntime({ SCANNER_SNAPSHOT: '/cfg/snapshot.json' }),
    (e) => e instanceof ScannerModeError,
  );
});

test('пустой контракт (без переменных) → ScannerModeError', () => {
  assert.throws(() => resolveScannerRuntime({}), (e) => e instanceof ScannerModeError);
});
