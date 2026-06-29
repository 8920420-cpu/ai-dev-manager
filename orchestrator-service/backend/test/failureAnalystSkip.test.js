import test from 'node:test';
import assert from 'node:assert/strict';
import { failureAnalysisHasRealFailure } from '../src/db.js';

// TESTS-GREEN-SKIP-FA-001 — аналитик сбоя запускается ТОЛЬКО при реальном провале
// последнего прогона тестов; при зелёном/отсутствующем пайплайне этап пропускается.
test('FAILED последнего pipeline_run = есть что диагностировать (аналитик нужен)', () => {
  assert.equal(failureAnalysisHasRealFailure('FAILED'), true);
  assert.equal(failureAnalysisHasRealFailure('failed'), true);
  assert.equal(failureAnalysisHasRealFailure(' FAILED '), true);
});

test('SUCCESS / отсутствие прогона / прочее = тесты зелёные (этап пропускаем)', () => {
  assert.equal(failureAnalysisHasRealFailure('SUCCESS'), false);
  assert.equal(failureAnalysisHasRealFailure(null), false);
  assert.equal(failureAnalysisHasRealFailure(undefined), false);
  assert.equal(failureAnalysisHasRealFailure(''), false);
  assert.equal(failureAnalysisHasRealFailure('RUNNING'), false);
});
