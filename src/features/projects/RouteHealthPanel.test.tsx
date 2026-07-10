import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// Мокаем клиент единой схемы — тест детерминирован и не ходит в сеть.
const getRouteHealthMock = vi.fn();
vi.mock('../../api/developmentSchemeApi', () => ({
  developmentSchemeApi: {
    getRouteHealth: () => getRouteHealthMock(),
  },
}));

import { RouteHealthPanel } from './RouteHealthPanel';
import type { RouteHealthReport } from '../../api/developmentSchemeApi';

beforeEach(() => {
  getRouteHealthMock.mockReset();
});

describe('RouteHealthPanel', () => {
  it('показывает проблему «роль без исполнителя» после проверки', async () => {
    const report: RouteHealthReport = {
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

    render(<RouteHealthPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Роль этапа не имеет исполнителя/i)).toBeInTheDocument();
    });
    expect(getRouteHealthMock).toHaveBeenCalled();
    expect(screen.getByText(/PROGRAMMER/)).toBeInTheDocument();
    expect(screen.getByText(/Назначьте роли коннектор или движок/i)).toBeInTheDocument();
    // Fork/join как «этап без статуса» не помечаются — такой проблемы в отчёте нет.
    expect(screen.queryByText(/без статуса/i)).not.toBeInTheDocument();
  });

  it('пустой отчёт (ok) показывает «Тупиков маршрута не найдено»', async () => {
    getRouteHealthMock.mockResolvedValue({
      problems: [],
      summary: { error: 0, warning: 0, total: 0, ok: true },
    } satisfies RouteHealthReport);

    render(<RouteHealthPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Тупиков маршрута не найдено/i)).toBeInTheDocument();
    });
  });

  it('показывает ошибку, если запрос упал', async () => {
    getRouteHealthMock.mockRejectedValue(new Error('Сервер недоступен'));

    render(<RouteHealthPanel />);
    await userEvent.click(screen.getByRole('button', { name: /Проверить маршрут/i }));

    await waitFor(() => {
      expect(screen.getByText(/Сервер недоступен/i)).toBeInTheDocument();
    });
  });
});
