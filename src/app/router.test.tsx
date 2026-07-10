import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import { RouterProvider, useRouter } from './router';
import { NAV_ITEMS } from './nav';
import { App } from '../App';

// Лёгкие заглушки для проверки только маршрутизации App (без API и тяжёлых страниц).
// AppShell заменён на прозрачную обёртку, чтобы не подтягивать Sidebar/Topbar и их запросы.
vi.mock('../components/layout/AppShell', () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../features/tasks/TasksPage', () => ({
  TasksPage: () => <div data-testid="page-tasks">TasksPage</div>,
}));
vi.mock('../features/projects/ConnectedProjectsPage', () => ({
  ConnectedProjectsPage: () => <div data-testid="page-projects">ProjectsPage</div>,
}));
vi.mock('../features/scheme/DevelopmentSchemePage', () => ({
  DevelopmentSchemePage: () => <div data-testid="page-departments">SchemePage</div>,
}));
vi.mock('../features/integrations/IntegrationsPage', () => ({
  IntegrationsPage: () => <div data-testid="page-integrations">IntegrationsPage</div>,
}));
vi.mock('../features/monitor/PerformanceMonitorPage', () => ({
  PerformanceMonitorPage: () => <div data-testid="page-monitor">MonitorPage</div>,
}));
vi.mock('../features/settings/RolesPage', () => ({
  RolesPage: () => <div data-testid="page-roles">RolesPage</div>,
}));
vi.mock('../features/settings/DatabasesPage', () => ({
  DatabasesPage: () => <div data-testid="page-databases">DatabasesPage</div>,
}));
vi.mock('../features/settings/ToolsPage', () => ({
  ToolsPage: () => <div data-testid="page-tools">ToolsPage</div>,
}));
vi.mock('../features/settings/ExecutionPage', () => ({
  ExecutionPage: () => <div data-testid="page-execution">ExecutionPage</div>,
}));
vi.mock('../features/auth/ApiTokenGate', () => ({
  ApiTokenGate: () => null,
}));

beforeEach(() => {
  window.location.hash = '';
});

describe('router — раздел «Задачи»', () => {
  it('#/tasks разбирается в маршрут tasks', () => {
    window.location.hash = '#/tasks';
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.route).toBe('tasks');
  });

  it('href(tasks) → #/tasks', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.href('tasks')).toBe('#/tasks');
  });

  it('navigate(tasks) обновляет hash и маршрут', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    act(() => result.current.navigate('tasks'));
    expect(window.location.hash).toBe('#/tasks');
    expect(result.current.route).toBe('tasks');
  });
});

describe('router — раздел «Разработка отделов»', () => {
  it('#/departments/development разбирается в маршрут departments-development', () => {
    window.location.hash = '#/departments/development';
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.route).toBe('departments-development');
  });

  it('href(departments-development) → #/departments/development', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.href('departments-development')).toBe('#/departments/development');
  });

  it('navigate(departments-development) обновляет hash и маршрут', () => {
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    act(() => result.current.navigate('departments-development'));
    expect(window.location.hash).toBe('#/departments/development');
    expect(result.current.route).toBe('departments-development');
  });

  it('обратная совместимость: старый #/scheme резолвится в departments-development', () => {
    window.location.hash = '#/scheme';
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.route).toBe('departments-development');
  });

  it('обратная совместимость: старый #/development-scheme резолвится в departments-development', () => {
    window.location.hash = '#/development-scheme';
    const { result } = renderHook(() => useRouter(), { wrapper: RouterProvider });
    expect(result.current.route).toBe('departments-development');
  });
});

describe('nav — пункт «Задачи»', () => {
  it('боковое меню содержит пункт «Задачи» с маршрутом tasks', () => {
    const item = NAV_ITEMS.find((i) => i.route === 'tasks');
    expect(item).toBeDefined();
    expect(item!.label).toBe('Задачи');
  });
});

describe('App — рендеринг страницы по маршруту', () => {
  it('при hash=#/tasks отрисовывает TasksPage', () => {
    window.location.hash = '#/tasks';
    render(<App />);
    expect(screen.getByTestId('page-tasks')).toBeInTheDocument();
    expect(screen.queryByTestId('page-projects')).not.toBeInTheDocument();
  });

  it('по умолчанию (пустой hash) отрисовывает ProjectsPage, а не TasksPage', () => {
    render(<App />);
    expect(screen.getByTestId('page-projects')).toBeInTheDocument();
    expect(screen.queryByTestId('page-tasks')).not.toBeInTheDocument();
  });
});
