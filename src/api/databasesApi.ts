/**
 * Репозиторий дополнительных подключений к базам данных — REST оркестратора
 * (`/api/additional-databases`). Секрет (пароль) НИКОГДА не хранится в браузере:
 * при чтении приходит только флаг `hasSecret`; пароль передаётся лишь в теле
 * create/update в момент действия пользователя.
 *
 * Основная (рабочая) БД PostgreSQL живёт на реальном backend (settingsApi):
 * она всегда доступна для выбора в проекте под идентификатором PRIMARY_DB_ID.
 */
import { settingsApi } from './settingsApi';
import { http } from './http';
import { makeId } from '../lib/format';
import type { ConnectedDatabase, DatabaseConnection } from '../types/settings';

/** Идентификатор основной (реальной) БД PostgreSQL из настроек backend. */
export const PRIMARY_DB_ID = 'primary-postgres';

/** Запись для выбора БД в проекте: основная PG + дополнительные. */
export interface SelectableDatabase {
  id: string;
  name: string;
  kind: 'primary' | 'additional';
}

/** Серверный контракт доп. БД (БЕЗ секрета). */
interface AdditionalDbRow {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: DatabaseConnection['sslMode'];
  hasSecret?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

function fromRow(row: AdditionalDbRow): DatabaseConnection {
  return {
    id: row.id,
    name: row.name ?? '',
    host: row.host ?? '',
    port: row.port ?? 5432,
    database: row.database ?? '',
    user: row.user ?? '',
    sslMode: row.sslMode ?? 'disable',
  };
}

/** Поля записи без секрета — общий payload для create/update. */
function toBody(item: DatabaseConnection, password?: string) {
  const body: Record<string, unknown> = {
    name: item.name.trim(),
    host: item.host.trim(),
    port: item.port,
    database: item.database.trim(),
    user: item.user.trim(),
    sslMode: item.sslMode,
  };
  // Пустой пароль не отправляем: на update это означает «не менять секрет».
  if (password && password.trim()) body.password = password;
  return body;
}

export const databasesApi = {
  /** Список дополнительных подключений (без секрета). */
  async list(signal?: AbortSignal): Promise<DatabaseConnection[]> {
    const res = await http.get<{ databases: AdditionalDbRow[] }>(
      '/api/additional-databases',
      { signal },
    );
    return (res.databases ?? []).map(fromRow);
  },

  async create(item: DatabaseConnection, password?: string): Promise<DatabaseConnection> {
    return fromRow(
      await http.post<AdditionalDbRow>('/api/additional-databases', toBody(item, password)),
    );
  },

  async update(
    id: string,
    item: DatabaseConnection,
    password?: string,
  ): Promise<DatabaseConnection> {
    return fromRow(
      await http.put<AdditionalDbRow>(
        `/api/additional-databases/${encodeURIComponent(id)}`,
        toBody(item, password),
      ),
    );
  },

  async remove(id: string): Promise<void> {
    await http.del(`/api/additional-databases/${encodeURIComponent(id)}`);
  },

  /**
   * Реально подключённые БД с backend (основная PostgreSQL + живой статус).
   * РЕАЛЬНЫЙ backend `GET /api/databases`. Только для чтения.
   */
  async listConnected(signal?: AbortSignal): Promise<ConnectedDatabase[]> {
    const res = await http.get<{ databases: ConnectedDatabase[] }>('/api/databases', {
      signal,
    });
    return res.databases ?? [];
  },

  /** UI-черновик нового подключения (id локальный, до сохранения на сервере). */
  make(): DatabaseConnection {
    return {
      id: makeId('db'),
      name: '',
      host: '',
      port: 5432,
      database: '',
      user: '',
      sslMode: 'disable',
    };
  },

  /**
   * Полный список БД, доступных для подключения проекта:
   * основная реальная PostgreSQL + дополнительные подключения (REST).
   */
  async listSelectable(): Promise<SelectableDatabase[]> {
    const [settings, extra] = await Promise.all([
      settingsApi.get().catch(() => null),
      this.list().catch(() => [] as DatabaseConnection[]),
    ]);
    const result: SelectableDatabase[] = [];
    if (settings) {
      result.push({
        id: PRIMARY_DB_ID,
        name: `PostgreSQL — ${settings.database || 'основная'}`,
        kind: 'primary',
      });
    }
    for (const db of extra) {
      result.push({
        id: db.id,
        name: db.name.trim() || db.database.trim() || 'Без названия',
        kind: 'additional',
      });
    }
    return result;
  },
};
