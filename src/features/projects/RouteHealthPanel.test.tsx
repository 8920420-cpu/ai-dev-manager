import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Мокаем клиент проектов — тест детерминирован и не ходит в сеть.
const getRouteHealthMock = vi.fn();
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getRouteHealth: (id: string) => getRouteHealthMock(id),
  },
}));

import { RouteHealthPanel } from './RouteHealthPanel';
import type { RouteHealthReport } from '../../api/projectsApi';

beforeEach(() => {
  getRouteHealthMock.mockReset();
});

describe('RouteHealthPanel', () => {
  it('показывает проблему «роль без исполнителя» после проверки', async () => {
    const report: RouteHealthReport = {
      projectId: 'p1',
      problems: [
        {
          code: 'role_without_executor',
          severity: 'error',
          stageId: 's1',
          stageName: 'Разработка',
          roleCode: 'PROGRAMMER',
          message: 'Роль этапа не имеет исполнителя.',
          recommendation: 'Назначьте роли коннектор или движок.',
        },
      ],
      summary: { error: 1, warning: 0, total: 1, ok: false },
    };
    getRouteHealthMock.mockResolvedValue(report);

    render(<RouteHealthPanel projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Роль этапа не имеет исполнителя/i)).toBeInTheDocument();
    });
    expect(getRouteHealthMock).toHaveBeenCalledWith('p1');
    expect(screen.getByText(/PROGRAMMER/)).toBeInTheDocument();
    expect(screen.getByText(/Назначьте роли коннектор или движок/i)).toBeInTheDocument();
    // Fork/join как «этап без статуса» не помечаются — такой проблемы в отчёте нет.
    expect(screen.queryByText(/без статуса/i)).not.toBeInTheDocument();
  });

  it('пустой отчёт (ok) показывает «Тупиков маршрута не найдено»', async () => {
    getRouteHealthMock.mockResolvedValue({
      projectId: 'p1',
      problems: [],
      summary: { error: 0, warning: 0, total: 0, ok: true },
    } satisfies RouteHealthReport);

    render(<RouteHealthPanel projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Тупиков маршрута не найдено/i)).toBeInTheDocument();
    });
  });

  it('показывает ошибку, если запрос упал', async () => {
    getRouteHealthMock.mockRejectedValue(new Error('Сервер недоступен'));

    render(<RouteHealthPanel projectId="p1" />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Сервер недоступен/i)).toBeInTheDocument();
    });
  });
});
