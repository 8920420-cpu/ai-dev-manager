// PROGRAMMER-SELF-CHECK-001 — чистые функции политики самопроверки.
// Сам runWithSelfCheck дёргает SDK и git, поэтому здесь проверяем то, что можно
// проверить без побочных эффектов: разбор конфигурации и суммирование метрик
// ремонтных заходов (от него зависят KPI-цифры в agent_runs).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeAgentRuns, selfCheckConfig } from '../src/claudeAgent.js';

test('selfCheckConfig: по умолчанию включена с одним ремонтным заходом и baseline', () => {
  const cfg = selfCheckConfig({});
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.maxAttempts, 1);
  assert.equal(cfg.baseline, true);
  assert.ok(cfg.timeoutMs > 0);
});

test('selfCheckConfig: выключается флагом 0/false', () => {
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK: '0' }).enabled, false);
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK: 'false' }).enabled, false);
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK: '1' }).enabled, true);
});

test('selfCheckConfig: ремонтные заходы ограничены сверху, 0 — допустимое значение', () => {
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK_ATTEMPTS: '0' }).maxAttempts, 0);
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK_ATTEMPTS: '2' }).maxAttempts, 2);
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK_ATTEMPTS: '99' }).maxAttempts, 3,
    'потолок защищает от прогона, который не влезет в таймаут задачи');
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK_ATTEMPTS: 'abc' }).maxAttempts, 1);
});

test('selfCheckConfig: baseline отключается отдельно', () => {
  assert.equal(selfCheckConfig({ PROGRAMMER_SELF_CHECK_BASELINE: '0' }).baseline, false);
});

test('selfCheckConfig: некорректный таймаут откатывается к значению по умолчанию', () => {
  const bad = selfCheckConfig({ PROGRAMMER_VERIFY_TIMEOUT_MS: '-5' });
  assert.ok(bad.timeoutMs > 0);
  assert.equal(selfCheckConfig({ PROGRAMMER_VERIFY_TIMEOUT_MS: '1000' }).timeoutMs, 1000);
});

test('mergeAgentRuns: расход ремонта суммируется, cold start берётся от первого прогона', () => {
  const base = {
    ok: true,
    result: {
      summary: 'первичная правка',
      agent: {
        numTurns: 10, tokensIn: 100, tokensOut: 20, costUsd: 0.5, coldStartMs: 1200,
        tokensInput: 60, tokensCacheRead: 30, tokensCacheCreation: 10, totalCostUsd: 0.5,
      },
    },
  };
  const repair = {
    ok: true,
    result: {
      summary: 'починил упавший тест',
      agent: {
        numTurns: 4, tokensIn: 40, tokensOut: 8, costUsd: 0.2, coldStartMs: 900,
        tokensInput: 20, tokensCacheRead: 15, tokensCacheCreation: 5, totalCostUsd: 0.2,
      },
    },
  };

  const merged = mergeAgentRuns(base, repair);
  const a = merged.result.agent;
  assert.equal(a.numTurns, 14, 'ремонт не должен выглядеть бесплатным');
  assert.equal(a.tokensIn, 140);
  assert.equal(a.tokensOut, 28);
  assert.ok(Math.abs(a.costUsd - 0.7) < 1e-9);
  assert.equal(a.coldStartMs, 1200, 'cold start — свойство первого запуска');
  assert.equal(merged.result.summary, 'починил упавший тест');
  assert.equal(merged.result.initialSummary, 'первичная правка');
});

test('mergeAgentRuns: отсутствующие метрики не превращаются в нули', () => {
  const merged = mergeAgentRuns({ ok: true, result: { agent: {} } }, { ok: true, result: { agent: {} } });
  assert.equal(merged.result.agent.numTurns, undefined);
  assert.equal(merged.result.agent.costUsd, undefined);
});
