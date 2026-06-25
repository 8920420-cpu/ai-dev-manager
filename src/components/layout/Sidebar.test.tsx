import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// --- Моки зависимостей Sidebar ---

// useRouter из контекста-провайдера мокаем целиком, чтобы рендерить Sidebar
// без RouterProvider. navigate/href — простые заглушки.
const navigate = vi.fn();
vi.mock('../../app/router', () => ({
  useRouter: () => ({
    route: 'projects' as const,
    navigate,
    href: (to: string) => `#/${to}`,
  }),
}));

// projectsApi.list возвращает Promise со списком из 2 проектов.
const listMock = vi.fn();
vi.mock('../../api/projectsApi', () => ({
  PROJECTS_CHANGED_EVENT: 'adm-projects-changed',
  projectsApi: {
    list: () => listMock(),
  },
}));

// Шина «открыть монитор проекта».
const requestOpenProjectMonitor = vi.fn();
vi.mock('../../app/projectMonitorBus', () => ({
  requestOpenProjectMonitor: (id: string) => requestOpenProjectMonitor(id),
}));

import { Sidebar } from './Sidebar';

const PROJECTS = [
  {
    id: 'proj_1',
    name: 'Проект Альфа',
    path: '/a',
    status: 'active',
    stages: [],
    roles: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'proj_2',
    name: 'Проект Бета',
    path: '/b',
    status: 'active',
    stages: [],
    roles: [],
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
];

function renderSidebar(collapsed = false) {
  return render(
    <Sidebar collapsed={collapsed} onToggleCollapse={() => {}} />,
  );
}

// Возвращает кнопку-disclosure (шеврон) для категории по её aria-label.
function disclosure(label: string) {
  return screen.getByRole('button', {
    name: new RegExp(`(Раскрыть|Свернуть) «${label}»`),
  });
}

beforeEach(() => {
  navigate.mockClear();
  requestOpenProjectMonitor.mockClear();
  listMock.mockReset();
  listMock.mockResolvedValue(PROJECTS);
});

describe('Sidebar — сворачиваемые категории навигации', () => {
  it('раскрывает категорию по клику: показывает подсписок и ставит aria-expanded=true', async () => {
    const user = userEvent.setup();
    renderSidebar();
    // дождёмся загрузки проектов
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const btn = disclosure('Проекты');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    // подсписка ещё нет
    expect(screen.queryByText('Проект Альфа')).not.toBeInTheDocument();

    await user.click(btn);

    expect(disclosure('Проекты')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Проект Альфа')).toBeInTheDocument();
    expect(screen.getByText('Проект Бета')).toBeInTheDocument();
  });

  it('повторный клик сворачивает категорию (aria-expanded=false, подсписок скрыт)', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await user.click(disclosure('Проекты'));
    expect(screen.getByText('Проект Альфа')).toBeInTheDocument();

    await user.click(disclosure('Проекты'));
    expect(disclosure('Проекты')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Проект Альфа')).not.toBeInTheDocument();
  });

  it('открытие второй категории сворачивает первую (раскрыта не более одной)', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    // Раскрываем «Проекты»
    await user.click(disclosure('Проекты'));
    expect(disclosure('Проекты')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Проект Альфа')).toBeInTheDocument();

    // Раскрываем «Настройки» — «Проекты» должны свернуться
    await user.click(disclosure('Настройки'));
    expect(disclosure('Настройки')).toHaveAttribute('aria-expanded', 'true');
    expect(disclosure('Проекты')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Проект Альфа')).not.toBeInTheDocument();
    // показался дочерний пункт «Настройки» (раздел «Базы данных» удалён)
    expect(screen.getByText('Роли')).toBeInTheDocument();
  });

  it('aria-controls связывает кнопку с подсписком по id', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    const btn = disclosure('Проекты');
    const controls = btn.getAttribute('aria-controls');
    expect(controls).toBeTruthy();

    await user.click(btn);
    const sublist = document.getElementById(controls!);
    expect(sublist).toBeInTheDocument();
    expect(within(sublist!).getByText('Проект Альфа')).toBeInTheDocument();
  });

  it('клик по проекту в подсписке вызывает requestOpenProjectMonitor', async () => {
    const user = userEvent.setup();
    renderSidebar();
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    await user.click(disclosure('Проекты'));
    await user.click(screen.getByText('Проект Альфа'));

    expect(requestOpenProjectMonitor).toHaveBeenCalledWith('proj_1');
    expect(navigate).toHaveBeenCalledWith('projects');
  });

  it('в свёрнутом режиме кнопки-disclosure отсутствуют', async () => {
    renderSidebar(true);
    await waitFor(() => expect(listMock).toHaveBeenCalled());

    expect(
      screen.queryByRole('button', { name: /(Раскрыть|Свернуть) «Проекты»/ }),
    ).not.toBeInTheDocument();
  });
});
