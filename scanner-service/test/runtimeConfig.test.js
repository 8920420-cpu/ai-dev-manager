import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveScannerRuntime,
  ScannerModeError,
  LEGACY_SCANNER_ENV,
} from '../src/runtimeConfig.js';

// --- Выбор режима по новому контракту ---------------------------------------

test('api-режим: SCANNER_API_BASE задаёт mode=api и базу оркестратора (срез хвостового /)', () => {
  const rt = resolveScannerRuntime({ SCANNER_API_BASE: 'http://orchestrator/' });
  assert.equal(rt.mode, 'api');
  assert.equal(rt.apiBase, 'http://orchestrator');
  assert.equal(rt.orchestratorBase, 'http://orchestrator');
  assert.deepEqual(rt.legacyEnvIgnored, []);
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

// --- Legacy env больше не определяет режим и диагностируется ----------------

test('legacy single-watcher env НЕ включает режим: пустой контракт → ScannerModeError', () => {
  assert.throws(
    () =>
      resolveScannerRuntime({
        SCANNER_DOCUMENT: '/workspace/claude-tasks.json',
        SCANNER_STATE: '/workspace/.scanner-state.json',
        SCANNER_ENDPOINT: 'http://orchestrator/api/scanner/task-completed',
        FEEDER_ENABLED: 'true',
      }),
    (e) => e instanceof ScannerModeError && e.code === 'scanner_mode_unsupported',
  );
});

test('legacy env при валидном api-режиме игнорируется с диагностикой', () => {
  const rt = resolveScannerRuntime({
    SCANNER_API_BASE: 'http://orchestrator',
    SCANNER_DOCUMENT: '/workspace/claude-tasks.json',
    FEEDER_ENABLED: 'true',
    FEEDER_INTERVAL_MS: '3000',
  });
  assert.equal(rt.mode, 'api');
  assert.deepEqual(
    rt.legacyEnvIgnored.sort(),
    ['FEEDER_ENABLED', 'FEEDER_INTERVAL_MS', 'SCANNER_DOCUMENT'].sort(),
  );
});

test('сообщение об ошибке перечисляет проигнорированные legacy-переменные', () => {
  try {
    resolveScannerRuntime({ SCANNER_DOCUMENT: '/x', SCANNER_ENDPOINT: 'http://o' });
    assert.fail('ожидалась ScannerModeError');
  } catch (e) {
    assert.ok(e instanceof ScannerModeError);
    assert.match(e.message, /SCANNER_DOCUMENT/);
    assert.match(e.message, /SCANNER_ENDPOINT/);
  }
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

test('LEGACY_SCANNER_ENV перечисляет снятые переменные feeder/single-watcher', () => {
  for (const k of ['SCANNER_DOCUMENT', 'SCANNER_STATE', 'SCANNER_ENDPOINT', 'FEEDER_ENABLED']) {
    assert.ok(LEGACY_SCANNER_ENV.includes(k), `${k} должен числиться legacy`);
  }
});
