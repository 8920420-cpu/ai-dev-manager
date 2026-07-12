import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('./http', () => ({
  http: {
    get: (...args: unknown[]) => get(...args),
    post: vi.fn(),
    put: vi.fn(),
    del: vi.fn(),
  },
}));

import { performanceApi, type PerformanceMetrics } from './performanceApi';

// Базовый скелет ответа /api/performance без опционального блока
// roleLoadCompletedTotals — имитирует старый бэкенд, который его ещё не отдаёт.
function makeMetrics(over: Partial<PerformanceMetrics> = {}): PerformanceMetrics {
  return {
    generatedAt: '2026-07-12T00:00:00.000Z',
    projectId: null,
    tasks: {
      byStatus: {},
      total: 0,
      active: 0,
      blocked: 0,
      completed: 0,
      done: 0,
      cancelled: 0,
      failed: 0,
    },
    queue: { backlog: 0, codingUnclaimed: 0, review: 0, restart: 0 },
    throughput: { completedLastHour: 0, completedLast24h: 0, createdLast24h: 0 },
    rework: { transitions: 0, reworkExtra: 0, retryRate: 0 },
    timings: { averageCompletedDurationMs: null },
    programmer: { avgPasses: null, maxPasses: null, completions: 0, limitHits: 0 },
    roleLoad: [],
    roleLoadWindow: {
      stale: false,
      staleHours: 0,
      windowStart: null,
      windowEnd: null,
      lastActivityAt: null,
    },
    roleLoadTaskTotals: {
      tasks: 4,
      avgCost: 0.8,
      avgTokensIn: 1200,
      avgTokensOut: 350,
      avgWorkMs: 90000,
      delta: null,
    },
    roleLoadPeriods: {
      mode: 'fallback',
      current: null,
      previous: null,
      marker: null,
      previousHasRuns: false,
    },
    connector: {},
    ...over,
  };
}

describe('performanceApi.get', () => {
  beforeEach(() => get.mockReset());

  it('без projectId → GET /api/performance без query', async () => {
    get.mockResolvedValue(makeMetrics());
    const signal = new AbortController().signal;
    await performanceApi.get(undefined, signal);
    expect(get).toHaveBeenCalledTimes(1);
    const [path, opts] = get.mock.calls[0]!;
    expect(path).toBe('/api/performance');
    expect(opts).toEqual({ signal });
  });

  it('projectId попадает в query (фильтр проекта не смешивает чужие задачи)', async () => {
    get.mockResolvedValue(makeMetrics({ projectId: 'proj 1' }));
    await performanceApi.get('proj 1');
    const [path] = get.mock.calls[0]!;
    // Значение экранируется — фильтр адресный, а не глобальный.
    expect(path).toBe('/api/performance?projectId=proj%201');
  });

  it('толерантно читает ответ без roleLoadCompletedTotals (старый бэкенд)', async () => {
    const metrics = makeMetrics();
    get.mockResolvedValue(metrics);
    const res = await performanceApi.get();
    // Блок отсутствует — чтение не падает, поле undefined.
    expect(res.roleLoadCompletedTotals).toBeUndefined();
    // Итог периода читается как есть, без avgLeadMs в контракте taskTotals.
    expect(res.roleLoadTaskTotals.tasks).toBe(4);
    expect('avgLeadMs' in res.roleLoadTaskTotals).toBe(false);
  });

  it('прокидывает roleLoadCompletedTotals, когда бэкенд его прислал', async () => {
    const metrics = makeMetrics({
      roleLoadCompletedTotals: {
        tasks: 2,
        avgCost: 3.2,
        avgTokensIn: 5000,
        avgTokensOut: 1200,
        avgWorkMs: 600000,
        avgLeadMs: 3600000,
        delta: null,
      },
    });
    get.mockResolvedValue(metrics);
    const res = await performanceApi.get();
    expect(res.roleLoadCompletedTotals?.tasks).toBe(2);
    expect(res.roleLoadCompletedTotals?.avgLeadMs).toBe(3600000);
  });
});
