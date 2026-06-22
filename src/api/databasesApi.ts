/**
 * Репозиторий дополнительных подключений к базам данных.
 * ⚠️ BACKEND_REQUIRED: серверного API для именованных подключений пока нет —
 * данные хранятся локально (см. localStore). Пароли/секреты здесь НЕ хранятся.
 *
 * Основная (рабочая) БД PostgreSQL остаётся на реальном backend (settingsApi):
 * она всегда доступна для выбора в проекте под идентификатором PRIMARY_DB_ID.
 */
import { createCollectionRepo } from './localStore';
import { settingsApi } from './settingsApi';
import { makeId } from '../lib/format';
import type { DatabaseConnection } from '../types/settings';

const repo = createCollectionRepo<DatabaseConnection>('databases');

/** Идентификатор основной (реальной) БД PostgreSQL из настроек backend. */
export const PRIMARY_DB_ID = 'primary-postgres';

/** Запись для выбора БД в проекте: основная PG + дополнительные. */
export interface SelectableDatabase {
  id: string;
  name: string;
  kind: 'primary' | 'additional';
}

export const databasesApi = {
  async list(): Promise<DatabaseConnection[]> {
    return repo.list();
  },

  async saveAll(items: DatabaseConnection[]): Promise<DatabaseConnection[]> {
    return repo.saveAll(items);
  },

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
   * основная реальная PostgreSQL + дополнительные локальные подключения.
   */
  async listSelectable(): Promise<SelectableDatabase[]> {
    const [settings, extra] = await Promise.all([
      settingsApi.get().catch(() => null),
      repo.list(),
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
