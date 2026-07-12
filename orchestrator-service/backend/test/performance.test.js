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
  buildRoleLoadTaskTotals,
  buildRoleLoadPeriodTotals,
  computeMetricDelta,
  attachRoleLoadDeltas,
  attachRoleLoadTaskTotalsDelta,
  attachRoleLoadPeriodTotalsDelta,
  queryRoleLoadRows,
  queryRoleLoadPeriodTotalsRow,
  queryRoleLoadTaskTotalsRow,
  deriveRoleLoadBlock,
  isReleaseOutcome,
  RELEASE_OUTCOMES,
  buildProgrammerKindStats,
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

// PROGRAMMER-KIND-STATS-001 — разрез программиста по (task_kind × model).
test('buildProgrammerKindStats: successRate, средние и разделение failed/returns', () => {
  const rows = [
    // 10 прогонов, из них 3 — возвраты захвата: реальных попыток 7 (6 success + 1 failed).
    { task_kind: 'subtask', model: 'claude-sonnet-5', runs: 10, tasks: 8, success: 6,
      failed: 1, returns: 3, timeout: 0, avg_turns: 12.4, avg_cost: 0.03123, avg_tokens_in: 21000,
      avg_tokens_out: 1500, avg_cold_start: 18000, avg_ms: 95000 },
    { task_kind: 'service', model: 'claude-opus-4-8', runs: 4, tasks: 4, success: 3,
      failed: 1, returns: 2, timeout: 0, avg_turns: 41, avg_cost: 0.51, avg_tokens_in: null,
      avg_tokens_out: null, avg_cold_start: null, avg_ms: null },
  ];
  const out = buildProgrammerKindStats(rows);
  assert.equal(out.length, 2);
  assert.equal(out[0].taskKind, 'subtask');
  assert.equal(out[0].model, 'claude-sonnet-5');
  // successRate по РЕАЛЬНЫМ попыткам (6+1+0=7), без 3 возвратов: 6/7 ≈ 0.857.
  assert.equal(out[0].successRate, 0.857, 'successRate = success/(success+failed+timeout), без returns');
  assert.equal(out[0].runs, 10, 'runs — все прогоны, отдельно от знаменателя');
  assert.equal(out[0].avgTurns, 12.4);
  assert.equal(out[0].avgCost, 0.0312, 'стоимость округлена до 4 знаков');
  assert.equal(out[0].failed, 1);
  assert.equal(out[0].returns, 3);
  // Пустые средние (нет данных) → null, а не 0.
  assert.equal(out[1].avgTokensIn, null);
  assert.equal(out[1].avgColdStartMs, null);
  assert.equal(out[1].successRate, 0.75, '3/(3+1+0)');
});

test('buildProgrammerKindStats: пустой вход и null-поля не падают', () => {
  assert.deepEqual(buildProgrammerKindStats(), []);
  const [m] = buildProgrammerKindStats([{ task_kind: null, model: null, runs: 0 }]);
  assert.equal(m.taskKind, null);
  assert.equal(m.model, null);
  assert.equal(m.successRate, null, 'runs=0 → successRate null (нет деления на ноль)');
});

// ROLE-LOAD-TASK-TOTALS-001 — «Итого (полная задача)»: истинное сквозное среднее
// по DONE-задачам (среднее ПОЛНЫХ сумм задачи, а не сумма средних по ролям).

test('buildRoleLoadTaskTotals: средние полных сумм с округлением (cost 6 знаков, tokens/ms целые)', () => {
  const m = buildRoleLoadTaskTotals({
    tasks: 4,
    avg_cost: 1.23456789,
    avg_tokens_in: 12345.6,
    avg_tokens_out: 3456.4,
    avg_work_ms: 789123.7,
    avg_lead_ms: 3600000.4,
  });
  assert.equal(m.tasks, 4);
  assert.equal(m.avgCost, 1.234568); // до 6 знаков
  assert.equal(m.avgTokensIn, 12346); // до целого
  assert.equal(m.avgTokensOut, 3456);
  assert.equal(m.avgWorkMs, 789124);
  assert.equal(m.avgLeadMs, 3600000);
});

test('buildRoleLoadTaskTotals: tasks = 0 → все средние null (совокупность пуста)', () => {
  const m = buildRoleLoadTaskTotals({
    tasks: 0,
    avg_cost: null,
    avg_tokens_in: null,
    avg_tokens_out: null,
    avg_work_ms: null,
    avg_lead_ms: null,
  });
  assert.equal(m.tasks, 0);
  assert.equal(m.avgCost, null);
  assert.equal(m.avgTokensIn, null);
  assert.equal(m.avgTokensOut, null);
  assert.equal(m.avgWorkMs, null);
  assert.equal(m.avgLeadMs, null);
});

test('buildRoleLoadTaskTotals: пустой/undefined вход → tasks 0, средние null, без падения', () => {
  const empty = { tasks: 0, avgCost: null, avgTokensIn: null, avgTokensOut: null, avgWorkMs: null, avgLeadMs: null };
  assert.deepEqual(buildRoleLoadTaskTotals(), empty);
  assert.deepEqual(buildRoleLoadTaskTotals(undefined), empty);
  assert.deepEqual(buildRoleLoadTaskTotals({}), empty);
});

// ROLE-LOAD-DEPLOY-PERIOD-001 — период с нуля от последнего обновления + сравнение.

test('computeMetricDelta: рост при lowerIsBetter=false (Успех) → улучшение, зелёный', () => {
  // 8 → 10 успехов: +25%, для «чем больше тем лучше» это улучшение.
  const d = computeMetricDelta(10, 8, false);
  assert.equal(d.pct, 0.25);
  assert.equal(d.improved, true);
});

test('computeMetricDelta: рост при lowerIsBetter=true (Провал/Ср.время) → ухудшение, красный', () => {
  // 4 → 5: +25%, для «чем меньше тем лучше» это ухудшение.
  const d = computeMetricDelta(5, 4, true);
  assert.equal(d.pct, 0.25);
  assert.equal(d.improved, false);
});

test('computeMetricDelta: снижение «чем меньше тем лучше» → улучшение (стрелка вниз, зелёная)', () => {
  // 5000 → 4000 мс: −20%, улучшение.
  const d = computeMetricDelta(4000, 5000, true);
  assert.equal(d.pct, -0.2);
  assert.equal(d.improved, true);
});

test('computeMetricDelta: нулевое изменение → improved null (серый), pct 0', () => {
  const d = computeMetricDelta(100, 100, true);
  assert.equal(d.pct, 0);
  assert.equal(d.improved, null);
});

test('computeMetricDelta: нет сравнения (null-значения или база 0) → null', () => {
  assert.equal(computeMetricDelta(null, 5, true), null);
  assert.equal(computeMetricDelta(5, null, true), null);
  assert.equal(computeMetricDelta(5, 0, true), null); // база 0 → процент не определён
});

test('attachRoleLoadDeltas: дельта по коду роли для направленных метрик', () => {
  const current = deriveRoleLoad([{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 8, tasks: 4, success: 10, failed: 2, timeout: 0, running: 0,
    avg_ms: 4000, tokens_in: 8000, tokens_out: 2000,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.8, avg_cold_start_ms: 1000,
  }]);
  const previous = deriveRoleLoad([{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 6, tasks: 4, success: 8, failed: 4, timeout: 0, running: 0,
    avg_ms: 5000, tokens_in: 8000, tokens_out: 2000,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 1.0, avg_cold_start_ms: 1000,
  }]);
  const [row] = attachRoleLoadDeltas(current, previous);
  // Успех 8→10: +25%, улучшение (зелёный).
  assert.equal(row.delta.success.pct, 0.25);
  assert.equal(row.delta.success.improved, true);
  // Провал 4→2: −50%, улучшение.
  assert.equal(row.delta.failed.pct, -0.5);
  assert.equal(row.delta.failed.improved, true);
  // Ср. время 5000→4000: −20%, улучшение.
  assert.equal(row.delta.avgDurationMs.improved, true);
  // Токены на задачу не менялись → нулевая дельта (серый).
  assert.equal(row.delta.avgTokensInPerTask.pct, 0);
  assert.equal(row.delta.avgTokensInPerTask.improved, null);
});

// ROLE-LOAD-RATE-DELTA-001 — сырые счётчики (success/failed/timeout) за периоды
// РАЗНОЙ длины (текущий [маркер; now] короче зафиксированного периода сравнения)
// нельзя сравнивать напрямую: роль со стабильной частотой провалов показывала бы
// ложное «−80% провалов». При переданных длительностях нормируем на них (частоту).
test('attachRoleLoadDeltas: сырые счётчики нормируются на длительность периода', () => {
  const H = 3600_000;
  const mk = (n) => deriveRoleLoad([{
    role_code: 'X', role_name: 'X',
    runs: n, tasks: n, success: n, failed: n, timeout: 0, running: 0,
    avg_ms: 1000, tokens_in: 0, tokens_out: 0,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0, avg_cold_start_ms: null,
  }]);
  // Текущий период 2ч (failed=2), период сравнения 10ч (failed=10) → 1 провал/час в обоих.
  const [row] = attachRoleLoadDeltas(mk(2), mk(10), { currentDurationMs: 2 * H, previousDurationMs: 10 * H });
  assert.equal(row.delta.failed.pct, 0, 'нормированная частота провалов не изменилась');
  assert.equal(row.delta.failed.improved, null, 'нет ложного «улучшения»');
  assert.equal(row.delta.success.pct, 0, 'нормированная частота успехов не изменилась');
  // Средние (avgDurationMs) не нормируются — 1000→1000 = 0.
  assert.equal(row.delta.avgDurationMs.pct, 0);
});

test('attachRoleLoadDeltas: без длительностей — сырое сравнение (обратная совместимость)', () => {
  const mk = (n) => deriveRoleLoad([{
    role_code: 'X', role_name: 'X',
    runs: n, tasks: n, success: n, failed: n, timeout: 0, running: 0,
    avg_ms: 1000, tokens_in: 0, tokens_out: 0,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0, avg_cold_start_ms: null,
  }]);
  const [row] = attachRoleLoadDeltas(mk(2), mk(10)); // periods не переданы
  assert.equal(row.delta.failed.pct, -0.8, 'без нормировки — прежнее сырое сравнение 2 vs 10');
});

test('attachRoleLoadDeltas: роли нет в периоде сравнения → delta null (требование 4)', () => {
  const current = deriveRoleLoad([{
    role_code: 'REVIEWER', role_name: 'Ревьюер',
    runs: 3, tasks: 2, success: 3, failed: 0, timeout: 0, running: 0,
    avg_ms: 1000, tokens_in: 100, tokens_out: 50,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.01, avg_cold_start_ms: null,
  }]);
  // previous без REVIEWER (в периоде сравнения этой роли не было).
  const previous = deriveRoleLoad([{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 1, tasks: 1, success: 1, failed: 0, timeout: 0, running: 0,
    avg_ms: 1000, tokens_in: 100, tokens_out: 50,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.01, avg_cold_start_ms: null,
  }]);
  const [row] = attachRoleLoadDeltas(current, previous);
  assert.equal(row.delta, null);
});

test('attachRoleLoadDeltas: previousRows = null (первый деплой) → все delta null', () => {
  const current = deriveRoleLoad([{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 3, tasks: 2, success: 3, failed: 0, timeout: 0, running: 0,
    avg_ms: 1000, tokens_in: 100, tokens_out: 50,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.01, avg_cold_start_ms: null,
  }]);
  const [row] = attachRoleLoadDeltas(current, null);
  assert.equal(row.delta, null);
});

test('attachRoleLoadTaskTotalsDelta: дельта средних полных сумм к периоду сравнения', () => {
  const current = buildRoleLoadTaskTotals({
    tasks: 5, avg_cost: 0.8, avg_tokens_in: 8000, avg_tokens_out: 2000,
    avg_work_ms: 400000, avg_lead_ms: 3600000,
  });
  const previous = buildRoleLoadTaskTotals({
    tasks: 4, avg_cost: 1.0, avg_tokens_in: 8000, avg_tokens_out: 2000,
    avg_work_ms: 500000, avg_lead_ms: 3600000,
  });
  const out = attachRoleLoadTaskTotalsDelta(current, previous);
  // Стоимость 1.0→0.8: −20%, улучшение.
  assert.equal(out.delta.avgCost.pct, -0.2);
  assert.equal(out.delta.avgCost.improved, true);
  // Время работы 500000→400000: −20%, улучшение.
  assert.equal(out.delta.avgWorkMs.improved, true);
  // Токены не менялись → серый (improved null).
  assert.equal(out.delta.avgTokensIn.improved, null);
});

test('attachRoleLoadTaskTotalsDelta: нет периода сравнения или в нём 0 задач → delta null', () => {
  const current = buildRoleLoadTaskTotals({
    tasks: 5, avg_cost: 0.8, avg_tokens_in: 8000, avg_tokens_out: 2000,
    avg_work_ms: 400000, avg_lead_ms: 3600000,
  });
  assert.equal(attachRoleLoadTaskTotalsDelta(current, null).delta, null);
  const emptyPrev = buildRoleLoadTaskTotals({ tasks: 0 });
  assert.equal(attachRoleLoadTaskTotalsDelta(current, emptyPrev).delta, null);
});

// RELEASE-OUTCOMES-001 — «Возвраты захвата» против «настоящего провала агента».
// Инцидент 03.07.2026: 1407 из 1408 «провалов» PROGRAMMER были FAILED-прогонами с
// outcome='released' (петля захват→release), а не реальными провалами кода.

test('isReleaseOutcome: служебные исходы освобождения захвата → true (регистронезависимо)', () => {
  // Инцидентный исход + прочие служебные возвраты захвата.
  assert.equal(isReleaseOutcome('released'), true);
  assert.equal(isReleaseOutcome('RELEASED'), true);          // регистр не важен
  assert.equal(isReleaseOutcome('  released  '), true);      // пробелы обрезаются
  assert.equal(isReleaseOutcome('claude_assignment_timeout'), true);
  assert.equal(isReleaseOutcome('orchestrator_restart_reconcile'), true);
  assert.equal(isReleaseOutcome('orphan_run_timeout'), true);
  // Весь эталонный набор классифицируется как возврат.
  for (const o of RELEASE_OUTCOMES) assert.equal(isReleaseOutcome(o), true);
});

test('isReleaseOutcome: настоящие провалы агента и NULL/пустой → false (остаются «Провал»)', () => {
  assert.equal(isReleaseOutcome('max_turns_exceeded'), false);
  assert.equal(isReleaseOutcome('agent_reported_failure'), false);
  // Префиксный вариант (agent сам сообщил о провале с текстом) — тоже провал.
  assert.equal(isReleaseOutcome('agent_reported_failure: не собралось'), false);
  assert.equal(isReleaseOutcome('verdict_unparsed'), false);
  assert.equal(isReleaseOutcome('success'), false);
  // NULL/undefined/пустой outcome → провал (у возврата outcome всегда задан).
  assert.equal(isReleaseOutcome(null), false);
  assert.equal(isReleaseOutcome(undefined), false);
  assert.equal(isReleaseOutcome(''), false);
});

test('deriveRoleLoad: FAILED разделён на «Провал» (failed) и «Возвраты» (returns)', () => {
  // Данные инцидента 03.07.2026 для PROGRAMMER: 1 настоящий провал + 1407 возвратов.
  const rows = [{
    role_code: 'PROGRAMMER', role_name: 'Программист',
    runs: 1408, tasks: 2, success: 0, failed: 1, returns: 1407, timeout: 0, running: 0,
    avg_ms: 5000, tokens_in: 0, tokens_out: 0,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0, avg_cold_start_ms: null,
  }];
  const [m] = deriveRoleLoad(rows);
  assert.equal(m.failed, 1);       // только настоящий провал агента
  assert.equal(m.returns, 1407);   // возвраты захвата в пул, не провалы кода
});

test('deriveRoleLoad: returns отсутствует в строке → 0 (обратная совместимость)', () => {
  const rows = [{
    role_code: 'ARCHITECT', role_name: 'Архитектор',
    runs: 3, tasks: 3, success: 2, failed: 1, timeout: 0, running: 0,
    avg_ms: 4000, tokens_in: 100, tokens_out: 50,
    tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.1, avg_cold_start_ms: null,
  }];
  const [m] = deriveRoleLoad(rows);
  assert.equal(m.failed, 1);
  assert.equal(m.returns, 0);
});

test('buildRoleLoadTotals: returns прокидывается наряду с failed (вкладка «Суммы»)', () => {
  const rows = [{
    role_code: 'PROGRAMMER', role_name: 'Программист',
    runs: 1408, tasks: 2, success: 0, failed: 1, returns: 1407, timeout: 0,
    tokens_in: 0, tokens_out: 0, cost: 0,
  }];
  const [m] = buildRoleLoadTotals(rows);
  assert.equal(m.failed, 1);
  assert.equal(m.returns, 1407);
});

test('buildDailyModelStats: returns в строке модели и в итогах дня', () => {
  const rows = [
    {
      day: '2026-07-03', connectorId: 'drv', provider: 'claude_code', model: 'sonnet',
      driverType: 'driver', roleCode: 'PROGRAMMER', roleName: 'Программист',
      runs: 1408, success: 0, failed: 1, returns: 1407, timeout: 0, throttle: 0, running: 0,
      avgMs: 5000, medianMs: 5000, tokensIn: 0, tokensOut: 0, cost: 0,
    },
    {
      day: '2026-07-03', connectorId: 'c1', provider: 'openai', model: 'gpt-4o',
      driverType: 'api', roleCode: 'ARCHITECT', roleName: 'Архитектор',
      runs: 5, success: 4, failed: 1, returns: 0, timeout: 0, throttle: 0, running: 0,
      avgMs: 2000, medianMs: 2000, tokensIn: 10, tokensOut: 5, cost: 0.01,
    },
  ];
  const [day] = buildDailyModelStats(rows);
  assert.equal(day.models[0].returns, 1407);
  assert.equal(day.models[0].failed, 1);
  assert.equal(day.models[1].returns, 0);
  // Итоги дня суммируют возвраты обеих моделей.
  assert.equal(day.totals.returns, 1407);
  assert.equal(day.totals.failed, 2);
});

test('buildDailyModelStats: returns отсутствует в строке → 0 (обратная совместимость)', () => {
  const rows = [{
    day: '2026-07-01', connectorId: 'c1', provider: 'deepseek', model: 'deepseek-chat',
    driverType: 'api', roleCode: 'REVIEWER', roleName: 'Ревьюер',
    runs: 4, success: 3, failed: 1, timeout: 0, throttle: 0, running: 0,
    avgMs: 1000, medianMs: 1000, tokensIn: 0, tokensOut: 0, cost: 0,
  }];
  const [day] = buildDailyModelStats(rows);
  assert.equal(day.models[0].returns, 0);
  assert.equal(day.totals.returns, 0);
});

// ROLE-LOAD-UNIFIED-COHORT-001 — ЕДИНАЯ периодная когорта «Итого» + projectId-фильтр.
// Основной «Итого» вкладки «Средние на задачу» считается по ОДНОЙ когорте DISTINCT
// task_id прогонов периода (совпадает по составу со строками ролей), а не по независимой
// выборке DONE-задач. Lifecycle-когорта «Завершённые по DONE» вынесена отдельно.

// --- (a) чистый маппер периодной когорты --------------------------------------

test('buildRoleLoadPeriodTotals: средние per-task сумм периода (cost 6 знаков, tokens/ms целые), без avgLeadMs', () => {
  const m = buildRoleLoadPeriodTotals({
    tasks: 3,
    avg_cost: 1.2253941,
    avg_tokens_in: 811972.4,
    avg_tokens_out: 5123.6,
    avg_work_ms: 456789.7,
  });
  assert.equal(m.tasks, 3);
  assert.equal(m.avgCost, 1.225394); // до 6 знаков
  assert.equal(m.avgTokensIn, 811972); // до целого
  assert.equal(m.avgTokensOut, 5124);
  assert.equal(m.avgWorkMs, 456790);
  // Периодная когорта НЕ несёт сквозного avgLeadMs — это атрибут завершённой задачи.
  assert.equal('avgLeadMs' in m, false);
});

test('buildRoleLoadPeriodTotals: tasks = 0 → совокупность пуста, все средние null', () => {
  const m = buildRoleLoadPeriodTotals({
    tasks: 0, avg_cost: null, avg_tokens_in: null, avg_tokens_out: null, avg_work_ms: null,
  });
  assert.equal(m.tasks, 0);
  assert.equal(m.avgCost, null);
  assert.equal(m.avgTokensIn, null);
  assert.equal(m.avgTokensOut, null);
  assert.equal(m.avgWorkMs, null);
});

test('buildRoleLoadPeriodTotals: пустой/undefined вход → tasks 0, средние null, без падения', () => {
  const empty = { tasks: 0, avgCost: null, avgTokensIn: null, avgTokensOut: null, avgWorkMs: null };
  assert.deepEqual(buildRoleLoadPeriodTotals(), empty);
  assert.deepEqual(buildRoleLoadPeriodTotals(undefined), empty);
  assert.deepEqual(buildRoleLoadPeriodTotals({}), empty);
});

test('attachRoleLoadPeriodTotalsDelta: дельта периодной когорты без avgLeadMs', () => {
  const current = buildRoleLoadPeriodTotals({
    tasks: 5, avg_cost: 0.8, avg_tokens_in: 8000, avg_tokens_out: 2000, avg_work_ms: 400000,
  });
  const previous = buildRoleLoadPeriodTotals({
    tasks: 4, avg_cost: 1.0, avg_tokens_in: 8000, avg_tokens_out: 2000, avg_work_ms: 500000,
  });
  const out = attachRoleLoadPeriodTotalsDelta(current, previous);
  // Стоимость 1.0→0.8: −20%, улучшение.
  assert.equal(out.delta.avgCost.pct, -0.2);
  assert.equal(out.delta.avgCost.improved, true);
  // Время работы 500000→400000: −20%, улучшение.
  assert.equal(out.delta.avgWorkMs.improved, true);
  // Токены не менялись → серый (improved null).
  assert.equal(out.delta.avgTokensIn.improved, null);
  // avgLeadMs НЕ входит в дельту периодной когорты.
  assert.equal('avgLeadMs' in out.delta, false);
});

test('attachRoleLoadPeriodTotalsDelta: нет периода сравнения или в нём 0 задач → delta null', () => {
  const current = buildRoleLoadPeriodTotals({
    tasks: 5, avg_cost: 0.8, avg_tokens_in: 8000, avg_tokens_out: 2000, avg_work_ms: 400000,
  });
  assert.equal(attachRoleLoadPeriodTotalsDelta(current, null).delta, null);
  assert.equal(attachRoleLoadPeriodTotalsDelta(current, buildRoleLoadPeriodTotals({ tasks: 0 })).delta, null);
});

// --- клиент-заглушка pg: записывает вызовы, отвечает канонической строкой ------
// (SQL исполняет Postgres; здесь проверяем, что запросы СКОНСТРУИРОВАНЫ верно —
// именно эти клаузы обеспечивают когортную семантику и projectId-изоляцию в БД.)
function captureClient(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [row ?? {}], rowCount: 1 };
    },
  };
}

// --- (b)+(d)+(e) единая когорта: группировка по задаче, границы, projectId ------

test('queryRoleLoadPeriodTotalsRow: когорта по ar.task_id (роли не удваивают tasks), суммы прогонов, без статуса и ролей', async () => {
  const c = captureClient({ tasks: 3, avg_cost: 1.2, avg_tokens_in: 100, avg_tokens_out: 50, avg_work_ms: 1000 });
  const row = await queryRoleLoadPeriodTotalsRow(c, 'S', 'E');
  const { sql, params } = c.calls[0];
  // (b) когорта по задачам: GROUP BY ar.task_id → разные роли одной задачи = одна задача.
  assert.ok(/GROUP BY ar\.task_id/.test(sql), 'группировка по задаче');
  assert.ok(/count\(\*\)::int AS tasks/.test(sql), 'tasks = число уникальных задач когорты');
  assert.ok(!/JOIN roles/.test(sql), 'период не джойнит roles — роли не размножают задачи');
  // (b) повторные прогоны одной роли/задачи суммируются per-task.
  assert.ok(/sum\(ar\.cost\)/.test(sql) && /sum\(ar\.token_input\)/.test(sql), 'per-task суммы');
  // (c) статус прогона НЕ фильтруется → RUNNING-задачи входят в когорту.
  assert.ok(!/ar\.status/.test(sql), 'нет фильтра по статусу прогона (активные включены)');
  // (d) границы периода и task_id IS NOT NULL исключают прогоны вне окна/без задачи.
  assert.ok(/ar\.started_at >= \$1 AND ar\.started_at < \$2/.test(sql), 'полуинтервал по started_at');
  assert.ok(/ar\.task_id IS NOT NULL/.test(sql), 'служебные прогоны без задачи не в когорте');
  assert.deepEqual(params, ['S', 'E']);
  assert.equal(row.tasks, 3);
});

test('queryRoleLoadPeriodTotalsRow: projectId → JOIN tasks + t.project_id (чужой проект отсечён SQL)', async () => {
  const c = captureClient({ tasks: 1 });
  await queryRoleLoadPeriodTotalsRow(c, 'S', 'E', 7);
  const { sql, params } = c.calls[0];
  assert.ok(/JOIN tasks t ON t\.id = ar\.task_id/.test(sql), 'JOIN на tasks по ar.task_id');
  assert.ok(/t\.project_id = \$3/.test(sql), 'фильтр проекта на позиции $3');
  assert.equal(params[2], 7, 'projectDbId прокинут параметром');
});

test('queryRoleLoadPeriodTotalsRow: без projectId — глобально, без фильтра проекта', async () => {
  const c = captureClient({ tasks: 0 });
  await queryRoleLoadPeriodTotalsRow(c, 'S', 'E');
  const { sql, params } = c.calls[0];
  assert.ok(!/t\.project_id/.test(sql));
  assert.ok(!/JOIN tasks t/.test(sql));
  assert.deepEqual(params, ['S', 'E']);
});

test('queryRoleLoadRows: projectId → JOIN tasks + t.project_id, params прокинуты; без него — глобально', async () => {
  const withProj = captureClient({ role_code: 'X' });
  await queryRoleLoadRows(withProj, 'S', 'E', 42);
  const a = withProj.calls[0];
  assert.ok(/JOIN tasks t ON t\.id = ar\.task_id/.test(a.sql), 'JOIN на tasks');
  assert.ok(/t\.project_id = \$4/.test(a.sql), 'фильтр проекта на $4 (после start,end,RELEASE_OUTCOMES)');
  assert.deepEqual(a.params.slice(0, 2), ['S', 'E']);
  assert.equal(a.params[3], 42);

  const global = captureClient({ role_code: 'X' });
  await queryRoleLoadRows(global, 'S', 'E');
  const b = global.calls[0];
  assert.ok(!/t\.project_id/.test(b.sql), 'без projectId — нет фильтра проекта');
  assert.ok(!/JOIN tasks t/.test(b.sql), 'без projectId — нет JOIN на tasks');
  assert.equal(b.params.length, 3, 'params: start, end, RELEASE_OUTCOMES');
});

// --- (c)+(f) lifecycle-когорта: только DONE, все прогоны за жизненный цикл, lead ---

test('queryRoleLoadTaskTotalsRow: lifecycle — только DONE, все прогоны задачи, avgLeadMs создание→DONE', async () => {
  const c = captureClient({ tasks: 2, avg_cost: 3, avg_tokens_in: 5, avg_tokens_out: 6, avg_work_ms: 7, avg_lead_ms: 8 });
  await queryRoleLoadTaskTotalsRow(c, 'S', 'E');
  const { sql, params } = c.calls[0];
  // (c) когорта только DONE — активные (RUNNING) задачи сюда НЕ входят.
  assert.ok(/t\.status = 'DONE'/.test(sql), 'только завершённые по статусу DONE');
  // (f) все прогоны задачи без ограничения периодом (LEFT JOIN без bound по started_at).
  assert.ok(/LEFT JOIN agent_runs ar ON ar\.task_id = dt\.task_id/.test(sql), 'весь lifecycle прогонов задачи');
  assert.ok(!/ar\.started_at >= \$1/.test(sql), 'прогоны НЕ ограничены периодом окна');
  // (f) avgLeadMs = создание→DONE.
  assert.ok(/avg\(extract\(epoch FROM \(done_at - created_at\)\) \* 1000\) AS avg_lead_ms/.test(sql), 'lead = создание→DONE');
  assert.deepEqual(params, ['S', 'E']);
});

test('queryRoleLoadTaskTotalsRow: projectId → фильтр t.project_id на когорте DONE-задач', async () => {
  const c = captureClient({ tasks: 0 });
  await queryRoleLoadTaskTotalsRow(c, 'S', 'E', 11);
  const { sql, params } = c.calls[0];
  assert.ok(/t\.project_id = \$3/.test(sql));
  assert.equal(params[2], 11);
});

// --- сборка блока: две когорты, projectId прокинут во все запросы --------------
// Мини-клиент отвечает по первому подходящему regex-правилу (как в forkJoin.test.js).
function fakeBlockClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) return rule.reply;
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('deriveRoleLoadBlock: периодная когорта → roleLoadTaskTotals, lifecycle → roleLoadCompletedTotals; projectId во всех запросах', async () => {
  const PROJECT = 99;
  const markers = [
    { id: 'm2', ref: 'r2', description: 'last', created_at: '2026-07-12T00:00:00.000Z' },
    { id: 'm1', ref: 'r1', description: 'prev', created_at: '2026-07-11T00:00:00.000Z' },
  ];
  const c = fakeBlockClient([
    { re: /FROM kpi_markers/, reply: { rows: markers, rowCount: 2 } },
    // Период: единая когорта. tasks=3 включает активную (RUNNING) задачу.
    { re: /WITH per_task AS/, reply: { rows: [{ tasks: 3, avg_cost: 1.2, avg_tokens_in: 800, avg_tokens_out: 100, avg_work_ms: 5000 }], rowCount: 1 } },
    // Lifecycle: только DONE-задачи. tasks=2 (RUNNING не входит), есть avg_lead_ms.
    { re: /WITH done_tasks AS/, reply: { rows: [{ tasks: 2, avg_cost: 2.5, avg_tokens_in: 1500, avg_tokens_out: 300, avg_work_ms: 9000, avg_lead_ms: 3600000 }], rowCount: 1 } },
    // Строки ролей (одна роль, у неё есть активный прогон running=1).
    { re: /GROUP BY r\.code, r\.name/, reply: { rows: [
      { role_code: 'PROGRAMMER', role_name: 'Программист', runs: 5, tasks: 3, success: 3, failed: 0, returns: 0, timeout: 0, running: 1, avg_ms: 1000, tokens_in: 900, tokens_out: 120, tokens_cache_read: 0, tokens_cache_creation: 0, cost: 1.5, avg_cold_start_ms: null },
    ], rowCount: 1 } },
  ]);

  const res = await deriveRoleLoadBlock(c, '2026-07-12T05:00:00.000Z', PROJECT);

  // Основной «Итого» — периодная когорта: tasks = уникальные задачи таблицы (3), без avgLeadMs.
  assert.equal(res.roleLoadTaskTotals.tasks, 3);
  assert.equal(res.roleLoadTaskTotals.avgCost, 1.2);
  assert.equal('avgLeadMs' in res.roleLoadTaskTotals, false);
  assert.ok('delta' in res.roleLoadTaskTotals);

  // Отдельная lifecycle-когорта: только DONE (tasks=2), с avgLeadMs.
  assert.equal(res.roleLoadCompletedTotals.tasks, 2);
  assert.equal(res.roleLoadCompletedTotals.avgLeadMs, 3600000);
  assert.ok('delta' in res.roleLoadCompletedTotals);

  // (c) периодная когорта содержит активную задачу, которой нет в lifecycle-когорте.
  assert.ok(res.roleLoadTaskTotals.tasks > res.roleLoadCompletedTotals.tasks);

  // (e) projectId прокинут во ВСЕ запросы блока (кроме маркеров): период, lifecycle, строки ролей.
  const dataCalls = c.calls.filter((x) => !/FROM kpi_markers/.test(x.sql));
  assert.ok(dataCalls.length >= 3);
  for (const call of dataCalls) {
    assert.ok(call.params.includes(PROJECT), `projectDbId в параметрах: ${call.sql.slice(0, 32)}`);
  }
});

test('deriveRoleLoadBlock: fallback без маркеров — обе когорты присутствуют, дельты null, mode fallback', async () => {
  const c = fakeBlockClient([
    { re: /FROM kpi_markers/, reply: { rows: [], rowCount: 0 } },
    { re: /WITH per_task AS/, reply: { rows: [{ tasks: 4, avg_cost: 0.5, avg_tokens_in: 200, avg_tokens_out: 30, avg_work_ms: 4000 }], rowCount: 1 } },
    { re: /WITH done_tasks AS/, reply: { rows: [{ tasks: 2, avg_cost: 0.9, avg_tokens_in: 400, avg_tokens_out: 60, avg_work_ms: 8000, avg_lead_ms: 7200000 }], rowCount: 1 } },
    { re: /GROUP BY r\.code, r\.name/, reply: { rows: [
      { role_code: 'ARCHITECT', role_name: 'Архитектор', runs: 3, tasks: 2, success: 3, failed: 0, returns: 0, timeout: 0, running: 0, avg_ms: 1000, tokens_in: 100, tokens_out: 20, tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.3, avg_cold_start_ms: null, last_activity: '2026-07-12T00:00:00.000Z' },
    ], rowCount: 1 } },
  ]);

  const res = await deriveRoleLoadBlock(c, '2026-07-12T01:00:00.000Z');

  assert.equal(res.roleLoadPeriods.mode, 'fallback');
  // Периодная когорта → roleLoadTaskTotals (без avgLeadMs), дельта null (сравнения нет).
  assert.equal(res.roleLoadTaskTotals.tasks, 4);
  assert.equal(res.roleLoadTaskTotals.delta, null);
  assert.equal('avgLeadMs' in res.roleLoadTaskTotals, false);
  // Lifecycle-когорта → roleLoadCompletedTotals (с avgLeadMs), дельта null.
  assert.equal(res.roleLoadCompletedTotals.tasks, 2);
  assert.equal(res.roleLoadCompletedTotals.avgLeadMs, 7200000);
  assert.equal(res.roleLoadCompletedTotals.delta, null);
});

// --- (e) fallback: projectId сужает И границу окна (CTE bounds), не только строки ---
test('deriveRoleLoadBlock: fallback + projectId — граница окна (bounds) фильтруется по проекту', async () => {
  const PROJECT = 77;
  const c = fakeBlockClient([
    { re: /FROM kpi_markers/, reply: { rows: [], rowCount: 0 } },
    { re: /WITH per_task AS/, reply: { rows: [{ tasks: 1, avg_cost: 0.5, avg_tokens_in: 200, avg_tokens_out: 30, avg_work_ms: 4000 }], rowCount: 1 } },
    { re: /WITH done_tasks AS/, reply: { rows: [{ tasks: 1, avg_cost: 0.9, avg_tokens_in: 400, avg_tokens_out: 60, avg_work_ms: 8000, avg_lead_ms: 7200000 }], rowCount: 1 } },
    { re: /GROUP BY r\.code, r\.name/, reply: { rows: [
      { role_code: 'ARCHITECT', role_name: 'Архитектор', runs: 3, tasks: 2, success: 3, failed: 0, returns: 0, timeout: 0, running: 0, avg_ms: 1000, tokens_in: 100, tokens_out: 20, tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.3, avg_cold_start_ms: null, last_activity: '2026-07-10T00:00:00.000Z' },
    ], rowCount: 1 } },
  ]);

  await deriveRoleLoadBlock(c, '2026-07-12T01:00:00.000Z', PROJECT);

  // Запрос строк ролей (с CTE bounds) должен фильтровать по проекту саму границу окна,
  // иначе last_activity берётся глобально и окно якорится к чужой активности.
  const rolesCall = c.calls.find((x) => /GROUP BY r\.code, r\.name/.test(x.sql));
  assert.ok(rolesCall, 'fallback выполняет запрос строк ролей');
  // bounds считает max(started_at) по прогонам проекта (JOIN tasks + фильтр в CTE).
  assert.ok(/JOIN tasks tb ON tb\.id = ab\.task_id/.test(rolesCall.sql), 'bounds джойнит tasks по прогону');
  assert.ok(/max\(ab\.started_at\)[\s\S]*tb\.project_id = \$2/.test(rolesCall.sql), 'граница окна фильтруется по проекту ($2)');
  // Внешние строки ролей — тоже по проекту.
  assert.ok(/t\.project_id = \$2/.test(rolesCall.sql), 'внешние строки ролей фильтруются по проекту');
  assert.ok(rolesCall.params.includes(PROJECT), 'projectDbId прокинут параметром');

  // Периодная и lifecycle когорты в fallback тоже получают projectDbId.
  const dataCalls = c.calls.filter((x) => !/FROM kpi_markers/.test(x.sql));
  for (const call of dataCalls) {
    assert.ok(call.params.includes(PROJECT), `projectDbId в параметрах: ${call.sql.slice(0, 32)}`);
  }
});

// Без projectId fallback остаётся глобальным: bounds без JOIN/фильтра проекта.
test('deriveRoleLoadBlock: fallback без projectId — bounds глобальный, без фильтра проекта', async () => {
  const c = fakeBlockClient([
    { re: /FROM kpi_markers/, reply: { rows: [], rowCount: 0 } },
    { re: /WITH per_task AS/, reply: { rows: [{ tasks: 1 }], rowCount: 1 } },
    { re: /WITH done_tasks AS/, reply: { rows: [{ tasks: 1 }], rowCount: 1 } },
    { re: /GROUP BY r\.code, r\.name/, reply: { rows: [
      { role_code: 'ARCHITECT', role_name: 'Архитектор', runs: 1, tasks: 1, success: 1, failed: 0, returns: 0, timeout: 0, running: 0, avg_ms: 1000, tokens_in: 100, tokens_out: 20, tokens_cache_read: 0, tokens_cache_creation: 0, cost: 0.3, avg_cold_start_ms: null, last_activity: '2026-07-12T00:00:00.000Z' },
    ], rowCount: 1 } },
  ]);

  await deriveRoleLoadBlock(c, '2026-07-12T01:00:00.000Z');

  const rolesCall = c.calls.find((x) => /GROUP BY r\.code, r\.name/.test(x.sql));
  assert.ok(!/tb\.project_id/.test(rolesCall.sql), 'bounds без фильтра проекта');
  assert.ok(!/t\.project_id/.test(rolesCall.sql), 'строки ролей без фильтра проекта');
  assert.ok(!/JOIN tasks/.test(rolesCall.sql), 'fallback без projectId — без JOIN на tasks');
});
