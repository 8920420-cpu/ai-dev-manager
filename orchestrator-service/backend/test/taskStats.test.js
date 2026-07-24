import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTask,
  computeTaskRows,
  lastEntryIntoStatus,
  stageForStatus,
  clampPagination,
  TERMINAL_STATUSES,
  normalizeKpi,
  normalizeBlockReason,
  enrichTaskRows,
} from '../src/taskStats.js';

const iso = (ms) => new Date(ms).toISOString();

test('stageForStatus: известный статус → стабильный stageCode', () => {
  assert.equal(stageForStatus('CODING').stageCode, 'CODING');
  assert.equal(stageForStatus('REVIEW').stageName, 'Ревью');
  assert.equal(stageForStatus('WAT').stageCode, 'WAT'); // неизвестный — не падает
});

test('lastEntryIntoStatus: берётся ПОСЛЕДНИЙ вход (повторный заход в этап)', () => {
  const events = [
    { toStatus: 'CODING', createdAt: 2000 },
    { toStatus: 'REVIEW', createdAt: 3000 },
    { toStatus: 'CODING', createdAt: 4000 }, // вернули на доработку
  ];
  assert.equal(lastEntryIntoStatus(events, 'CODING'), 4000);
  assert.equal(lastEntryIntoStatus(events, 'DEPLOY'), null);
});

test('computeTask: активная задача — длительности растут к generatedAt', () => {
  const row = computeTask(
    { id: 't1', title: 'A', service: 'Catalog', status: 'CODING', createdAt: 1000 },
    [{ toStatus: 'CODING', createdAt: 2000 }],
    5000,
  );
  assert.equal(row.timingState, 'active');
  assert.equal(row.stageDurationMs, 3000); // 5000 - 2000
  assert.equal(row.totalDurationMs, 4000); // 5000 - 1000
  assert.equal(row.completedAt, null);
  assert.equal(row.stageStartedAt, iso(2000));
});

test('computeTask: активная длительность зависит только от generatedAt', () => {
  const base = { id: 't1', title: 'A', status: 'CODING', createdAt: 1000 };
  const ev = [{ toStatus: 'CODING', createdAt: 2000 }];
  const at6 = computeTask(base, ev, 6000);
  const at9 = computeTask(base, ev, 9000);
  assert.equal(at6.stageDurationMs, 4000);
  assert.equal(at9.stageDurationMs, 7000); // выросла относительно generatedAt
});

test('computeTask: повторный вход в этап использует последний интервал', () => {
  const row = computeTask(
    { id: 't1', title: 'A', status: 'CODING', createdAt: 1000 },
    [
      { toStatus: 'CODING', createdAt: 2000 },
      { toStatus: 'REVIEW', createdAt: 3000 },
      { toStatus: 'CODING', createdAt: 4000 },
    ],
    5000,
  );
  assert.equal(row.stageStartedAt, iso(4000));
  assert.equal(row.stageDurationMs, 1000); // 5000 - 4000
  assert.equal(row.totalDurationMs, 4000); // total — сквозной, включая возвраты
});

test('computeTask: завершённая (DONE) — длительности фиксированы, не растут', () => {
  const make = (genAt) =>
    computeTask(
      { id: 't1', title: 'A', status: 'DONE', createdAt: 1000 },
      [
        { toStatus: 'CODING', createdAt: 2000 },
        { toStatus: 'DONE', createdAt: 4000 },
      ],
      genAt,
    );
  const a = make(9000);
  const b = make(99999);
  assert.equal(a.timingState, 'completed');
  assert.equal(a.completedAt, iso(4000));
  assert.equal(a.totalDurationMs, 3000); // 4000 - 1000
  assert.equal(a.stageDurationMs, 0); // вошёл в DONE в 4000, этап начат 4000
  assert.deepEqual(
    { total: a.totalDurationMs, stage: a.stageDurationMs },
    { total: b.totalDurationMs, stage: b.stageDurationMs },
  );
});

test('computeTask: терминальный статус без события завершения → null + timingState', () => {
  const row = computeTask(
    { id: 't1', title: 'A', status: 'FAILED', createdAt: 1000 },
    [{ toStatus: 'CODING', createdAt: 2000 }],
    5000,
  );
  assert.equal(row.timingState, 'missing_completion');
  assert.equal(row.completedAt, null);
  assert.equal(row.totalDurationMs, null);
  assert.equal(row.stageDurationMs, null);
});

test('computeTask: нет created_at → missing_created, длительности null', () => {
  const row = computeTask({ id: 't1', title: 'A', status: 'CODING', createdAt: null }, [], 5000);
  assert.equal(row.timingState, 'missing_created');
  assert.equal(row.totalDurationMs, null);
  assert.equal(row.stageDurationMs, null);
});

test('computeTask: активная без переходов — этап начат при создании', () => {
  const row = computeTask({ id: 't1', title: 'A', status: 'READY', createdAt: 1000 }, [], 4000);
  assert.equal(row.stageStartedAt, iso(1000));
  assert.equal(row.stageDurationMs, 3000);
  assert.equal(row.totalDurationMs, 3000);
});

test('computeTask: заблокированная задача считается «текущей» (растёт)', () => {
  const row = computeTask(
    { id: 't1', title: 'A', status: 'BLOCKED', createdAt: 1000 },
    [{ toStatus: 'BLOCKED', createdAt: 3000 }],
    7000,
  );
  assert.equal(row.timingState, 'active');
  assert.equal(row.stageDurationMs, 4000);
  assert.equal(row.stageCode, 'BLOCKED');
});

test('computeTask: рассинхрон времени не даёт отрицательную длительность', () => {
  const row = computeTask(
    { id: 't1', title: 'A', status: 'CODING', createdAt: 5000 },
    [{ toStatus: 'CODING', createdAt: 6000 }],
    4000, // generatedAt раньше — защита от отрицательных
  );
  assert.equal(row.stageDurationMs, 0);
  assert.equal(row.totalDurationMs, 0);
});

test('computeTaskRows: сопоставляет события по task_id', () => {
  const rows = computeTaskRows(
    {
      tasks: [
        { id: 't1', title: 'A', status: 'CODING', createdAt: 1000 },
        { id: 't2', title: 'B', status: 'READY', createdAt: 1000 },
      ],
      eventsByTask: new Map([['t1', [{ toStatus: 'CODING', createdAt: 2000 }]]]),
    },
    5000,
  );
  assert.equal(rows[0].stageStartedAt, iso(2000));
  assert.equal(rows[1].stageStartedAt, iso(1000)); // без событий — created
});

test('clampPagination: дефолты и границы', () => {
  assert.deepEqual(clampPagination({}), { limit: 50, offset: 0 });
  assert.deepEqual(clampPagination({ limit: '10', offset: '20' }), { limit: 10, offset: 20 });
  assert.deepEqual(clampPagination({ limit: '99999', offset: '-5' }), { limit: 200, offset: 0 });
  assert.deepEqual(clampPagination({ limit: 'x' }), { limit: 50, offset: 0 });
});

test('TERMINAL_STATUSES содержит DONE/CANCELLED/FAILED', () => {
  assert.ok(TERMINAL_STATUSES.has('DONE'));
  assert.ok(TERMINAL_STATUSES.has('CANCELLED'));
  assert.ok(TERMINAL_STATUSES.has('FAILED'));
  assert.equal(TERMINAL_STATUSES.has('BLOCKED'), false);
});

// --- OBSERVABILITY-BLOCK-KPI-001 -------------------------------------------

test('normalizeKpi: пусто → нули', () => {
  assert.deepEqual(normalizeKpi(null), {
    tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheCreation: 0,
    tokenFreshInput: 0, cost: 0, turns: 0, runs: 0, failedRuns: 0,
  });
});

test('normalizeKpi: строки pg (bigint/numeric) → числа, свежий ввод без кэша', () => {
  const kpi = normalizeKpi({
    token_input: '1000', token_output: '50', token_cache_read: '600',
    token_cache_creation: '100', cost: '3.030492', turns: '41',
    runs: '10', failed_runs: '2',
  });
  assert.equal(kpi.tokenInput, 1000);
  assert.equal(kpi.tokenOutput, 50);
  assert.equal(kpi.tokenFreshInput, 300); // 1000 - 600 - 100
  assert.equal(kpi.cost, 3.030492);
  assert.equal(kpi.turns, 41);
  assert.equal(kpi.runs, 10);
  assert.equal(kpi.failedRuns, 2);
});

test('normalizeKpi: кэш больше ввода → tokenFreshInput не отрицательный', () => {
  const kpi = normalizeKpi({ token_input: '100', token_cache_read: '200' });
  assert.equal(kpi.tokenFreshInput, 0);
});

test('normalizeBlockReason: null без данных, объект при наличии', () => {
  assert.equal(normalizeBlockReason(null), null);
  assert.equal(normalizeBlockReason({ note: null, error: null, role: null }), null);
  const r = normalizeBlockReason({
    note: 'cherry_pick_failed', error: 'conflict', role: 'GIT_INTEGRATOR', at: 1000,
  });
  assert.equal(r.note, 'cherry_pick_failed');
  assert.equal(r.role, 'GIT_INTEGRATOR');
  assert.equal(r.at, new Date(1000).toISOString());
});

test('enrichTaskRows: проставляет blockReason/kpi/docForcedAdvance по task_id', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  enrichTaskRows(rows, {
    blockByTask: new Map([['a', { note: 'cherry_pick_failed', role: 'GIT_INTEGRATOR' }]]),
    kpiByTask: new Map([['a', { token_input: '10', cost: '1.5', runs: '1' }]]),
    docForcedSet: new Set(['b']),
  });
  assert.equal(rows[0].blockReason.note, 'cherry_pick_failed');
  assert.equal(rows[0].kpi.tokenInput, 10);
  assert.equal(rows[0].docForcedAdvance, false);
  assert.equal(rows[1].blockReason, null);
  assert.equal(rows[1].kpi.runs, 0); // нет agent_runs → нули
  assert.equal(rows[1].docForcedAdvance, true); // force-продвинут (doc-ветка)
  assert.equal(rows[2].blockReason, null);
  assert.equal(rows[2].docForcedAdvance, false);
});
