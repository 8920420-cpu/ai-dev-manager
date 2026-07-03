// PERFORMANCE-MONITOR-001 — тесты чистого расчёта производных KPI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveKpi,
  deriveVersionDeltas,
  buildDailyModelStats,
  deriveRoleLoad,
  computeRoleLoadWindow,
  buildRoleLoadTotals,
} from '../src/performance.js';

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

// ROLE-ENGINE-ROUTING-002 — дневная статистика по коннекторам/моделям.

test('buildDailyModelStats: две модели за один день → две отдельные строки', () => {
  const rows = [
    {
      day: '2026-07-01', connectorId: 'c1', provider: 'deepseek', model: 'deepseek-chat',
      driverType: 'api', roleCode: 'ARCHITECT', roleName: 'Архитектор',
      runs: 6, success: 5, failed: 1, timeout: 0, throttle: 0, running: 0,
      avgMs: 4000, medianMs: 3800, tokensIn: 6000, tokensOut: 3000, cost: 0.12,
    },
    {
      day: '2026-07-01', connectorId: 'c2', provider: 'openai', model: 'gpt-4o',
      driverType: 'api', roleCode: 'ARCHITECT', roleName: 'Архитектор',
      runs: 4, success: 4, failed: 0, timeout: 0, throttle: 0, running: 0,
      avgMs: 2000, medianMs: 2100, tokensIn: 2000, tokensOut: 1000, cost: 0.20,
    },
  ];
  const out = buildDailyModelStats(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].day, '2026-07-01');
  // Один день — две строки для старой и новой модели.
  assert.equal(out[0].models.length, 2);
  assert.deepEqual(out[0].models.map((m) => m.model), ['deepseek-chat', 'gpt-4o']);
  // Итоги дня агрегируют обе модели.
  assert.equal(out[0].totals.runs, 10);
  assert.equal(out[0].totals.success, 9);
  assert.equal(out[0].totals.models, 2);
  assert.equal(out[0].totals.successRate, 0.9);
});

test('buildDailyModelStats: маппинг provider/driver/model/role сохраняется как есть', () => {
  const rows = [{
    day: '2026-07-02', connectorId: 'drv', provider: 'claude_code', model: 'sonnet',
    driverType: 'driver', roleCode: 'PROGRAMMER', roleName: 'Программист',
    runs: 3, success: 3, failed: 0, timeout: 0, throttle: 0, running: 0,
    avgMs: 1000, medianMs: 1000, tokensIn: 0, tokensOut: 0, cost: 0,
  }];
  const m = buildDailyModelStats(rows)[0].models[0];
  assert.equal(m.provider, 'claude_code');
  assert.equal(m.driverType, 'driver');
  assert.equal(m.model, 'sonnet');
  assert.equal(m.connectorId, 'drv');
  assert.equal(m.roleCode, 'PROGRAMMER');
  assert.equal(m.roleName, 'Программист');
});

test('buildDailyModelStats: successRate, avgTokens, avgCost, median, timeout/throttle', () => {
  const rows = [{
    day: '2026-07-03', connectorId: 'c1', provider: 'deepseek', model: 'deepseek-chat',
    driverType: 'api', roleCode: 'REVIEWER', roleName: 'Ревьюер',
    runs: 10, success: 7, failed: 1, timeout: 1, throttle: 1, running: 0,
    avgMs: 3333.7, medianMs: 2999.4, tokensIn: 8000, tokensOut: 2000, cost: 0.5,
  }];
  const m = buildDailyModelStats(rows)[0].models[0];
  assert.equal(m.successRate, 0.7);       // 7/10
  assert.equal(m.timeout, 1);
  assert.equal(m.throttle, 1);
  assert.equal(m.failed, 1);
  assert.equal(m.avgDurationMs, 3334);    // округление до целого мс
  assert.equal(m.medianDurationMs, 2999);
  assert.equal(m.tokensIn, 8000);
  assert.equal(m.tokensOut, 2000);
  assert.equal(m.avgTokens, 1000);        // (8000+2000)/10
  assert.equal(m.cost, 0.5);
  assert.equal(m.avgCost, 0.05);          // 0.5/10
});

test('buildDailyModelStats: несколько дней в исходном порядке; null-метрики без падения', () => {
  const rows = [
    {
      day: '2026-07-05', connectorId: null, provider: null, model: null, driverType: null,
      roleCode: 'ARCHITECT', roleName: 'Архитектор',
      runs: 0, success: 0, failed: 0, timeout: 0, throttle: 0, running: 0,
      avgMs: null, medianMs: null, tokensIn: 0, tokensOut: 0, cost: 0,
    },
    {
      day: '2026-07-04', connectorId: 'c1', provider: 'openai', model: 'gpt-4o', driverType: 'api',
      roleCode: 'ARCHITECT', roleName: 'Архитектор',
      runs: 2, success: 1, failed: 0, timeout: 0, throttle: 0, running: 1,
      avgMs: 500, medianMs: 500, tokensIn: 10, tokensOut: 10, cost: 0.01,
    },
  ];
  const out = buildDailyModelStats(rows);
  assert.deepEqual(out.map((d) => d.day), ['2026-07-05', '2026-07-04']);
  // runs=0 → производные null, без деления на ноль.
  assert.equal(out[0].models[0].successRate, null);
  assert.equal(out[0].models[0].avgTokens, null);
  assert.equal(out[0].models[0].avgCost, null);
  assert.equal(out[0].models[0].avgDurationMs, null);
  assert.equal(out[0].models[0].medianDurationMs, null);
  // Второй день: running учитывается, provider/model прокинуты.
  assert.equal(out[1].models[0].running, 1);
  assert.equal(out[1].models[0].provider, 'openai');
});

test('buildDailyModelStats: пустой вход не падает', () => {
  assert.deepEqual(buildDailyModelStats(), []);
  assert.deepEqual(buildDailyModelStats([]), []);
});

// ROLE-LOAD-AVG-001 — средние на задачу в основном виде блока «Нагрузка по ролям».

test('deriveRoleLoad: токены/стоимость усредняются на задачу (sum / DISTINCT task_id)', () => {
  const rows = [{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 6, tasks: 3, success: 5, failed: 1, timeout: 0, running: 0,
    avg_ms: 4000, tokens_in: 9000, tokens_out: 3000,
    tokens_cache_read: 3000, tokens_cache_creation: 1500, cost: 0.6, avg_cold_start_ms: 1200,
  }];
  const [m] = deriveRoleLoad(rows);
  // Суммы сохранены (для вкладки «Суммы» и разбивки кэша).
  assert.equal(m.tokensIn, 9000);
  assert.equal(m.tokensOut, 3000);
  assert.equal(m.cost, 0.6);
  // Средние на задачу: 9000/3, 3000/3, 0.6/3.
  assert.equal(m.avgTokensInPerTask, 3000);
  assert.equal(m.avgTokensOutPerTask, 1000);
  assert.equal(m.avgCostPerTask, 0.2);
  // Свежий = tokens_in − cache_read − cache_creation = 9000 − 3000 − 1500.
  assert.equal(m.tokensInputFresh, 4500);
  assert.equal(m.tasks, 3);
});

test('deriveRoleLoad: tasks = 0 → средние = null (без деления на ноль)', () => {
  const rows = [{
    role_code: 'REVIEWER', role_name: 'Ревьюер',
    runs: 2, tasks: 0, success: 2, failed: 0, timeout: 0, running: 0,
    avg_ms: null, tokens_in: 500, tokens_out: 100,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.01, avg_cold_start_ms: null,
  }];
  const [m] = deriveRoleLoad(rows);
  assert.equal(m.avgTokensInPerTask, null);
  assert.equal(m.avgTokensOutPerTask, null);
  assert.equal(m.avgCostPerTask, null);
  assert.equal(m.avgDurationMs, null);
  assert.equal(m.avgColdStartMs, null);
});

test('deriveRoleLoad: пустой вход не падает', () => {
  assert.deepEqual(deriveRoleLoad(), []);
  assert.deepEqual(deriveRoleLoad([]), []);
});

// ROLE-LOAD-LAST-DATA-001 — окно якорится к последней активности + флаг устаревания.

test('computeRoleLoadWindow: простой > окна → stale, но границы указывают на последние данные', () => {
  const last = '2026-07-01T00:00:00.000Z';
  const now = '2026-07-03T00:00:00.000Z'; // +48 ч
  const w = computeRoleLoadWindow(last, now, 24);
  assert.equal(w.stale, true);
  assert.equal(w.staleHours, 48);
  assert.equal(w.windowEnd, last);
  assert.equal(w.lastActivityAt, last);
  // Начало окна = last − 24ч.
  assert.equal(w.windowStart, '2026-06-30T00:00:00.000Z');
});

test('computeRoleLoadWindow: активность внутри окна → не stale', () => {
  const last = '2026-07-03T00:00:00.000Z';
  const now = '2026-07-03T06:00:00.000Z'; // +6 ч < 24ч
  const w = computeRoleLoadWindow(last, now, 24);
  assert.equal(w.stale, false);
  assert.equal(w.staleHours, 0);
  assert.equal(w.windowEnd, last);
});

test('computeRoleLoadWindow: нет активности (null) → пустое окно без падения', () => {
  const w = computeRoleLoadWindow(null, '2026-07-03T00:00:00.000Z', 24);
  assert.equal(w.stale, false);
  assert.equal(w.windowEnd, null);
  assert.equal(w.windowStart, null);
  assert.equal(w.lastActivityAt, null);
});

// ROLE-LOAD-LAST-DATA-001 — вкладка «Суммы»: суммарные значения по ролям.

test('buildRoleLoadTotals: суммы прокидываются как есть, без усреднения', () => {
  const rows = [{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 12, tasks: 5, success: 10, failed: 2, timeout: 0,
    tokens_in: 20000, tokens_out: 8000, cost: 1.234567,
  }];
  const [m] = buildRoleLoadTotals(rows);
  assert.equal(m.runs, 12);
  assert.equal(m.tasks, 5);
  assert.equal(m.success, 10);
  assert.equal(m.tokensIn, 20000);
  assert.equal(m.tokensOut, 8000);
  // Стоимость округляется до 6 знаков.
  assert.equal(m.cost, 1.234567);
});

test('buildRoleLoadTotals: пустой вход не падает', () => {
  assert.deepEqual(buildRoleLoadTotals(), []);
  assert.deepEqual(buildRoleLoadTotals([]), []);
});
