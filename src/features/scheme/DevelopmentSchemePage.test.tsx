import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import type { ReactElement } from 'react';
import type { Role, Stage } from '../../types/project';
import type { DevelopmentScheme } from '../../api/developmentSchemeApi';

// --- Моки сетевых клиентов страницы ---------------------------------------
//
// FORK-JOIN-001 / регресс TASK_REVIEWER: важно проверить путь ЗАГРУЗКИ страницы
// (load), а не только сохранение. Backend может вернуть уже сохранённые рёбра,
// в которых Documentation Auditor и Keeper стоят как ПАРАЛЛЕЛЬНЫЕ одноузловые
// ветки (старая логика). Страница обязана вывести рёбра из узлов + ролей заново
// (deriveSchemeEdges) и показать документационную ветку последовательно.

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

// Роли документационной ветки и Git Integrator — сопоставление по каноническому коду.
const ROLES: Role[] = [
  { id: 'rDA', name: 'Documentation Auditor', code: 'DOCUMENTATION_AUDITOR' },
  { id: 'rDK', name: 'Documentation Keeper', code: 'DOCUMENTATION_KEEPER' },
  { id: 'rGI', name: 'Git Integrator', code: 'GIT_INTEGRATOR' },
];

// Узлы: fork → (Auditor, Keeper, Git Integrator) → join.
const STAGES: Stage[] = [
  { id: 'F', stageKey: 'F', kind: 'fork', name: 'Разделить', roleIds: [], enabled: true },
  { id: 'DA', stageKey: 'DA', kind: 'stage', name: 'Documentation Auditor', roleIds: ['rDA'], enabled: true },
  { id: 'DK', stageKey: 'DK', kind: 'stage', name: 'Documentation Keeper', roleIds: ['rDK'], enabled: true },
  { id: 'GI', stageKey: 'GI', kind: 'stage', name: 'Git Integrator', roleIds: ['rGI'], enabled: true },
  { id: 'J', stageKey: 'J', kind: 'join', name: 'Объединить', roleIds: [], enabled: true },
];

// Сохранённые «старые» рёбра: КАЖДЫЙ узел — отдельная параллельная ветка
// (F→DA, DA→J, F→DK, DK→J, F→GI, GI→J) → тремя колонками. Именно из этого
// состояния страница должна восстановить правильную двухколоночную раскладку.
const LEGACY_PARALLEL_EDGES = [
  { fromKey: 'F', toKey: 'DA', condition: null, position: 0 },
  { fromKey: 'DA', toKey: 'J', condition: null, position: 1 },
  { fromKey: 'F', toKey: 'DK', condition: null, position: 2 },
  { fromKey: 'DK', toKey: 'J', condition: null, position: 3 },
  { fromKey: 'F', toKey: 'GI', condition: null, position: 4 },
  { fromKey: 'GI', toKey: 'J', condition: null, position: 5 },
];

const SCHEME: DevelopmentScheme = { stages: STAGES, roles: ROLES, edges: LEGACY_PARALLEL_EDGES };

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

describe('DevelopmentSchemePage — загрузка сохранённой схемы (регресс отображения)', () => {
  it('при сохранённых «параллельных» рёбрах Auditor/Keeper рисует ровно две колонки: Auditor→Keeper и Git Integrator', async () => {
    renderPage();

    // Дожидаемся готовности схемы: появился блок параллельных веток после fork.
    const branchesGroup = await screen.findByRole('group', { name: 'Параллельные ветки' });

    // Ровно две ветки-колонки (а не три параллельные из сохранённых рёбер).
    const branchEls = Array.from(branchesGroup.children) as HTMLElement[];
    expect(branchEls).toHaveLength(2);

    // Колонка 1 — документационная цепочка: Auditor сверху, Keeper под ним.
    expect(within(branchEls[0]!).getByText('Documentation Auditor')).toBeInTheDocument();
    expect(within(branchEls[0]!).getByText('Documentation Keeper')).toBeInTheDocument();
    expect(within(branchEls[0]!).queryByText('Git Integrator')).not.toBeInTheDocument();

    // Колонка 2 — отдельная параллельная ветка Git Integrator.
    expect(within(branchEls[1]!).getByText('Git Integrator')).toBeInTheDocument();
    expect(within(branchEls[1]!).queryByText('Documentation Auditor')).not.toBeInTheDocument();
    expect(within(branchEls[1]!).queryByText('Documentation Keeper')).not.toBeInTheDocument();
  });

  it('вызывает загрузку схемы (get) при монтировании', async () => {
    renderPage();
    await waitFor(() => expect(getMock).toHaveBeenCalled());
  });
});
