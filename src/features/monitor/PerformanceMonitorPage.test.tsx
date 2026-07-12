import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom';

import type {
  PerformanceMetrics,
  RoleLoad,
  RoleLoadCompletedTotals,
  ProgrammerKindStats,
  VersionMetrics,
} from '../../api/performanceApi';

// --- Моки клиента performanceApi ------------------------------------------
// PerformanceMonitorPage тянет основной срез через performanceApi.get, а вложенные
// разделы — versions/programmerByKind в своих эффектах. Мокаем весь модуль, чтобы
// тест не ходил в сеть и был детерминирован.
const getMock = vi.fn();
const versionsMock = vi.fn();
const programmerByKindMock = vi.fn();
const roleLoadTotalsMock = vi.fn();

vi.mock('../../api/performanceApi', () => ({
  performanceApi: {
    get: (...a: unknown[]) => getMock(...a),
    versions: (...a: unknown[]) => versionsMock(...a),
    programmerByKind: (...a: unknown[]) => programmerByKindMock(...a),
    roleLoadTotals: (...a: unknown[]) => roleLoadTotalsMock(...a),
    createMarker: vi.fn(),
  },
}));

import { PerformanceMonitorPage } from './PerformanceMonitorPage';

// --- Тестовые данные -------------------------------------------------------

const ROLE: RoleLoad = {
  roleCode: 'PROGRAMMER',
  roleName: 'Программист',
  runs: 5,
  tasks: 3,
  success: 4,
  failed: 1,
  returns: 0,
  timeout: 0,
  running: 0,
  avgDurationMs: 60_000,
  tokensIn: 3000,
  tokensOut: 900,
  tokensInputFresh: 1000,
  tokensCacheCreation: 500,
  tokensCacheRead: 1500,
  cost: 1.5,
  avgTokensInPerTask: 1000,
  avgTokensOutPerTask: 300,
  avgCostPerTask: 0.5,
  avgColdStartMs: 2000,
  delta: null,
};

const COMPLETED: RoleLoadCompletedTotals = {
  tasks: 2,
  avgCost: 3.2,
  avgTokensIn: 5000,
  avgTokensOut: 1200,
  avgWorkMs: 600_000,
  avgLeadMs: 3_600_000,
  delta: null,
};

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
    roleLoad: [ROLE],
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
      avgWorkMs: 90_000,
      delta: null,
    },
    roleLoadCompletedTotals: COMPLETED,
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

const EMPTY_VERSIONS: VersionMetrics = {
  generatedAt: '2026-07-12T00:00:00.000Z',
  role: { code: 'PROGRAMMER', name: 'Программист' },
  windowHours: 168,
  source: 'task_events',
  minSample: 5,
  regressionPct: 0.1,
  versions: [],
  markers: [],
};

const EMPTY_KIND: ProgrammerKindStats = {
  generatedAt: '2026-07-12T00:00:00.000Z',
  windowHours: 720,
  projectId: null,
  rows: [],
};

describe('PerformanceMonitorPage — когорты «Нагрузка по ролям»', () => {
  beforeEach(() => {
    getMock.mockReset();
    versionsMock.mockReset().mockResolvedValue(EMPTY_VERSIONS);
    programmerByKindMock.mockReset().mockResolvedValue(EMPTY_KIND);
    roleLoadTotalsMock.mockReset();
  });

  it('строка «Итого» переименована в единую когорту периода, а старое название убрано', async () => {
    getMock.mockResolvedValue(makeMetrics());
    render(<PerformanceMonitorPage />);

    expect(await screen.findByText('Итого (единая когорта периода)')).toBeInTheDocument();
    expect(screen.queryByText('Итого (полная задача)')).not.toBeInTheDocument();
  });

  it('число задач итога = число уникальных задач таблицы (taskTotals.tasks), а не сумма ролей', async () => {
    getMock.mockResolvedValue(makeMetrics());
    render(<PerformanceMonitorPage />);

    const totalCell = await screen.findByTitle(/знаменатель средних/i);
    // taskTotals.tasks = 4; сумма task-ов ролей была бы 3 — итог берёт единую когорту.
    expect(totalCell).toHaveTextContent('4');
  });

  it('столбец «Ср. время» переименован в «Ср. время / прогон» с уточняющим tooltip', async () => {
    getMock.mockResolvedValue(makeMetrics());
    render(<PerformanceMonitorPage />);

    const th = await screen.findByText('Ср. время / прогон');
    expect(th).toBeInTheDocument();
    expect(th).toHaveAttribute('title', expect.stringContaining('одного прогона'));
  });

  it('показывает карточку «Завершённые задачи (полный lifecycle)» с avgLeadMs, когда бэкенд её прислал', async () => {
    getMock.mockResolvedValue(makeMetrics());
    render(<PerformanceMonitorPage />);

    expect(
      await screen.findByText('Завершённые задачи (по событию DONE, полный lifecycle)'),
    ).toBeInTheDocument();
    // avgLeadMs (создание → DONE) — только в этой карточке, не в строке «Итого».
    expect(screen.getByText(/создание → DONE/)).toBeInTheDocument();
  });

  it('не рендерит карточку завершённых, если бэкенд старее и блока нет', async () => {
    getMock.mockResolvedValue(makeMetrics({ roleLoadCompletedTotals: undefined }));
    render(<PerformanceMonitorPage />);

    // Итог периода есть всегда, а карточка полного lifecycle — только при наличии блока.
    expect(await screen.findByText('Итого (единая когорта периода)')).toBeInTheDocument();
    expect(
      screen.queryByText('Завершённые задачи (по событию DONE, полный lifecycle)'),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/создание → DONE/)).not.toBeInTheDocument();
  });
});
