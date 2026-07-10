import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { DatabaseConnectionsSection } from './DatabaseConnectionsSection';
import type { DbConnection } from '../../types/settings';

const list = vi.fn();
vi.mock('../../api/databaseConnectionsApi', () => ({
  databaseConnectionsApi: { list: (...a: unknown[]) => list(...a) },
  DbConnectionInUseError: class extends Error {},
  isDraftConnectionId: () => false,
}));

const CONN: DbConnection = {
  id: 'uuid-1',
  name: 'Каталог-БД',
  dbmsType: 'postgres',
  host: 'h',
  port: 5432,
  database: 'catalog',
  user: 'app',
  sslMode: 'disable',
  hasSecret: false,
};

function renderSection() {
  render(
    <ToastProvider>
      <DatabaseConnectionsSection />
    </ToastProvider>,
  );
}

beforeEach(() => {
  list.mockReset();
});

describe('DatabaseConnectionsSection — единый экран подключений', () => {
  it('нет прежних форм/секций: только список и кнопка «Подключить»', async () => {
    list.mockResolvedValue([CONN]);
    renderSection();
    await waitFor(() => screen.getByText('Каталог-БД'));
    // Кнопка «Подключить» присутствует (в шапке секции).
    expect(screen.getAllByRole('button', { name: /Подключить/i }).length).toBeGreaterThan(0);
    // Нет терминов primary/additional и старых заголовков.
    expect(screen.queryByText(/Дополнительные базы данных/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Параметры подключения оркестратора/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Перенос локальных данных/i)).not.toBeInTheDocument();
  });

  it('пустое состояние предлагает создать подключение', async () => {
    list.mockResolvedValue([]);
    renderSection();
    await waitFor(() => screen.getByText(/Подключений пока нет/i));
  });

  it('открывает форму подключения по кнопке «Подключить»', async () => {
    const user = userEvent.setup();
    list.mockResolvedValue([CONN]);
    renderSection();
    await waitFor(() => screen.getByText('Каталог-БД'));
    await user.click(screen.getAllByRole('button', { name: /Подключить/i })[0]!);
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Подключить базу данных/i);
  });

  it('ошибка загрузки не ломает экран и даёт повтор', async () => {
    list.mockRejectedValue(new Error('boom'));
    renderSection();
    await waitFor(() => screen.getByText(/Не удалось загрузить подключения/i));
    expect(screen.getByRole('button', { name: /Повторить/i })).toBeInTheDocument();
  });
});
