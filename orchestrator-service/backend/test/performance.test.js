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
  computeMetricDelta,
  attachRoleLoadDeltas,
  attachRoleLoadTaskTotalsDelta,
  isReleaseOutcome,
  RELEASE_OUTCOMES,
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
