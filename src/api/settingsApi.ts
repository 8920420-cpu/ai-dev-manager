/**
 * РЕАЛЬНЫЙ backend-слой настроек PostgreSQL и операций с БД.
 * Endpoints (orchestrator-service/backend):
 *   GET  /api/settings          → текущие настройки БЕЗ пароля (hasPassword)
 *   POST /api/settings          → сохранить настройки (пустой пароль = не менять)
 *   POST /api/db/test           → проверить подключение
 *   POST /api/db/init           → создать БД + миграции
 *   POST /api/db/seed           → загрузить примеры
 *   GET  /api/db/status         → состояние БД
 *
 * Безопасность: пароль НИКОГДА не приходит с сервера и не хранится на клиенте.
 * Он передаётся только в теле POST /api/settings|db/test в момент действия
 * пользователя и не пишется в localStorage и не логируется.
 */
import { http } from './http';
import type { PgSettings, PgSslMode } from '../types/settings';

/** Сырой ответ backend (redactSettings). */
interface RawSettings {
  host: string;
  port: number;
  user: string;
  database: string;
  adminDatabase: string;
  hasPassword: boolean;
  /** sslMode — расширение контракта; backend пока может его игнорировать. */
  sslMode?: PgSslMode;
}

function toPgSettings(raw: RawSettings): PgSettings {
  return {
    host: raw.host ?? '127.0.0.1',
    port: raw.port ?? 5432,
    user: raw.user ?? 'postgres',
    database: raw.database ?? 'orchestrator_db',
    adminDatabase: raw.adminDatabase ?? 'postgres',
    sslMode: raw.sslMode ?? 'disable',
    hasPassword: Boolean(raw.hasPassword),
  };
}

/** Тело запроса на сохранение/проверку. password опционален. */
export interface PgPatch {
  host: string;
  port: number;
  user: string;
  database: string;
  adminDatabase: string;
  sslMode: PgSslMode;
  /** Пустая строка/undefined = не менять сохранённый пароль. */
  password?: string;
}

export interface DbActionResult {
  ok?: boolean;
  message?: string;
  [k: string]: unknown;
}

export const settingsApi = {
  async get(): Promise<PgSettings> {
    return toPgSettings(await http.get<RawSettings>('/api/settings'));
  },

  async save(patch: PgPatch): Promise<PgSettings> {
    return toPgSettings(await http.post<RawSettings>('/api/settings', patch));
  },

  /** Проверка подключения без сохранения. */
  async test(patch: PgPatch): Promise<DbActionResult> {
    return http.post<DbActionResult>('/api/db/test', patch);
  },

  async status(): Promise<DbActionResult> {
    return http.get<DbActionResult>('/api/db/status');
  },
};
