import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReactElement } from 'react';
import type { Role, Stage } from '../../types/project';
import type { DevelopmentScheme } from '../../api/developmentSchemeApi';

// --- Моки сетевых клиентов страницы ---------------------------------------
//
// SCHEME-GRAPH-LAYOUT-001 — проверяем путь ЗАГРУЗКИ (load): сохранённые рёбра схемы
// (`global_stage_edges`) — источник истины маршрута и НЕ подменяются клиентским
// deriveSchemeEdges. В частности, УСЛОВНАЯ развилка Task Router (small→Mini Architect /
// иначе→Architect) выражена именно рёбрами с condition — deriveSchemeEdges такие
// рёбра не генерирует, поэтому подпись «small» на экране доказывает: рисуются
// сохранённые рёбра, а не выведенные заново.

const getMock = vi.fn();
const getRuntimeMock = vi.fn();
vi.mock('../../api/developmentSchemeApi', () => ({
  developmentSchemeApi: {
    get: () => getMock(),
    getRuntime: () => getRuntimeMock(),
    save: vi.fn(),
    setOrchestratorEnabled: vi.fn(),
  },
}));

// tasksApi нужен странице для счётчиков и подписки на изменения задач — мокаем,
// чтобы тест был детерминирован и не ходил в сеть.
vi.mock('../../api/tasksApi', () => ({
  subscribeTaskChanges: () => () => {},
  tasksApi: {
    stats: () => Promise.resolve({ byStatus: {}, runningByStatus: {}, total: 0 }),
  },
}));

import { ToastProvider } from '../../components/ui';
import { DevelopmentSchemePage } from './DevelopmentSchemePage';

const ROLES: Role[] = [
  { id: 'rIntake', name: 'Task Intake', code: 'TASK_INTAKE_OFFICER' },
  { id: 'rRouter', name: 'Task Router', code: 'TASK_ROUTER' },
  { id: 'rMini', name: 'Mini Architect', code: 'MINI_ARCHITECT' },
  { id: 'rArch', name: 'Architect', code: 'ARCHITECT' },
  { id: 'rProg', name: 'Programmer', code: 'PROGRAMMER' },
];

// Узлы контура: Intake → Router → {Mini | Architect} → Programmer.
const STAGES: Stage[] = [
  { id: 'intake', stageKey: 'intake', kind: 'stage', name: 'Приёмщик', roleIds: ['rIntake'], enabled: true },
  { id: 'router', stageKey: 'router', kind: 'stage', name: 'Task Router', roleIds: ['rRouter'], enabled: true },
  { id: 'mini', stageKey: 'mini', kind: 'stage', name: 'Mini Architect', roleIds: ['rMini'], enabled: true },
  { id: 'arch', stageKey: 'arch', kind: 'stage', name: 'Architect', roleIds: ['rArch'], enabled: true },
  { id: 'prog', stageKey: 'prog', kind: 'stage', name: 'Programmer', roleIds: ['rProg'], enabled: true },
];

// Сохранённая УСЛОВНАЯ развилка: router→mini(small) / router→arch(fallback), обе ветки
// сходятся на Programmer. Именно эти рёбра страница обязана нарисовать без подмены.
const CONDITIONAL_EDGES = [
  { fromKey: 'intake', toKey: 'router', condition: null, position: 0 },
  { fromKey: 'router', toKey: 'mini', condition: 'small', position: 0 },
  { fromKey: 'router', toKey: 'arch', condition: null, position: 1 },
  { fromKey: 'mini', toKey: 'prog', condition: null, position: 0 },
  { fromKey: 'arch', toKey: 'prog', condition: null, position: 0 },
];

const SCHEME: DevelopmentScheme = { stages: STAGES, roles: ROLES, edges: CONDITIONAL_EDGES };

function renderPage(): ReturnType<typeof render> {
  const ui: ReactElement = (
    <ToastProvider>
      <DevelopmentSchemePage />
    </ToastProvider>
  );
  return render(ui);
}

beforeEach(() => {
  getMock.mockReset();
  getRuntimeMock.mockReset();
  getMock.mockResolvedValue(SCHEME);
  getRuntimeMock.mockResolvedValue({ orchestratorEnabled: true });
});

afterEach(() => {
  cleanup();
});

describe('DevelopmentSchemePage — сохранённые рёбра рисуются без подмены deriveEdges', () => {
  it('условная развилка Task Router из сохранённых рёбер: small→Mini Architect / иначе→Architect', async () => {
    renderPage();

    // Дожидаемся готовности схемы: появилось ветвление по условию.
    const branchGroup = await screen.findByRole('group', { name: 'Ветвление по условию' });

    // Ровно две ветки-колонки.
    const columns = Array.from(branchGroup.children) as HTMLElement[];
    expect(columns).toHaveLength(2);

    // Колонка 1 — ветка small с подписью условия и Mini Architect.
    expect(within(columns[0]!).getByText('small')).toBeInTheDocument();
    expect(within(columns[0]!).getByText('Mini Architect')).toBeInTheDocument();
    expect(within(columns[0]!).queryByText('Architect')).not.toBeInTheDocument();

    // Колонка 2 — fallback («по умолчанию») и полный Architect.
    expect(within(columns[1]!).getByText('по умолчанию')).toBeInTheDocument();
    expect(within(columns[1]!).getByText('Architect')).toBeInTheDocument();

    // Программист — узел схождения обеих веток (нарисован после развилки).
    expect(screen.getByText('Programmer')).toBeInTheDocument();
  });

  it('подпись условия «small» есть только из сохранённых рёбер (deriveEdges их не создаёт)', async () => {
    renderPage();
    // Если бы страница выводила рёбра заново через deriveSchemeEdges, условных подписей
    // не было бы вовсе — deriveSchemeEdges не генерирует condition-рёбра.
    expect(await screen.findByText('small')).toBeInTheDocument();
  });

  it('вызывает загрузку схемы (get) при монтировании', async () => {
    renderPage();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
  });
});
