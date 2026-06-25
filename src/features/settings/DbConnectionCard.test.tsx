import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { DbConnectionCard } from './DbConnectionCard';
import type { DbConnection } from '../../types/settings';

const test = vi.fn();
const remove = vi.fn();
// vi.hoisted: класс должен быть инициализирован до поднятого vi.mock (объявление
// класса не поднимается как const-фабрика vi.fn и иначе попадает в TDZ).
const { DbConnectionInUseError } = vi.hoisted(() => {
  class DbConnectionInUseError extends Error {
    count: number;
    dependents: { id: string; code: string; name: string }[];
    constructor(count: number, dependents: { id: string; code: string; name: string }[]) {
      super('in use');
      this.name = 'DbConnectionInUseError';
      this.count = count;
      this.dependents = dependents;
    }
  }
  return { DbConnectionInUseError };
});
vi.mock('../../api/databaseConnectionsApi', () => ({
  databaseConnectionsApi: {
    test: (...a: unknown[]) => test(...a),
    remove: (...a: unknown[]) => remove(...a),
  },
  DbConnectionInUseError,
}));

const CONN: DbConnection = {
  id: 'uuid-1',
  name: 'Каталог-БД',
  dbmsType: 'postgres',
  host: '127.0.0.1',
  port: 5432,
  database: 'catalog',
  user: 'app',
  sslMode: 'disable',
  hasSecret: true,
};

function renderCard(onRemoved = vi.fn(), onEdit = vi.fn()) {
  render(
    <ToastProvider>
      <ul>
        <DbConnectionCard connection={CONN} onEdit={onEdit} onRemoved={onRemoved} />
      </ul>
    </ToastProvider>,
  );
  return { onRemoved, onEdit };
}

beforeEach(() => {
  test.mockReset();
  remove.mockReset();
});

describe('DbConnectionCard — карточка подключения', () => {
  it('показывает тип СУБД, адрес и НЕ показывает секрет', () => {
    renderCard();
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('127.0.0.1:5432')).toBeInTheDocument();
    // Пароль не раскрывается — только факт его наличия.
    expect(screen.getByText('Задан на сервере')).toBeInTheDocument();
    expect(screen.queryByText(/s3cret|password/i)).not.toBeInTheDocument();
  });

  it('проверка соединения показывает статус ошибки без реквизитов', async () => {
    const user = userEvent.setup();
    test.mockResolvedValue({ connected: false, error: 'authentication_failed' });
    renderCard();
    await user.click(screen.getByRole('button', { name: /Проверить/i }));
    await waitFor(() => expect(screen.getByText(/authentication_failed/i)).toBeInTheDocument());
  });

  it('удаление вызывает onRemoved при успехе', async () => {
    const user = userEvent.setup();
    remove.mockResolvedValue(undefined);
    const { onRemoved } = renderCard();
    await user.click(screen.getByRole('button', { name: /Удалить подключение «Каталог-БД»/i }));
    await user.click(screen.getByRole('button', { name: /^Удалить$/i }));
    await waitFor(() => expect(onRemoved).toHaveBeenCalledWith('uuid-1'));
  });

  it('конфликт удаления показывает зависимые проекты и не зовёт onRemoved', async () => {
    const user = userEvent.setup();
    remove.mockRejectedValue(
      new DbConnectionInUseError(1, [{ id: 'p1', code: 'PS', name: 'ПС' }]),
    );
    const { onRemoved } = renderCard();
    await user.click(screen.getByRole('button', { name: /Удалить подключение «Каталог-БД»/i }));
    await user.click(screen.getByRole('button', { name: /^Удалить$/i }));
    await waitFor(() =>
      expect(screen.getByText(/используется проектами/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/ПС/)).toBeInTheDocument();
    expect(onRemoved).not.toHaveBeenCalled();
  });
});
