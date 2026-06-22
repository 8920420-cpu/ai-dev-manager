/** Типы настроек: соответствие ролей коннекторам и подключение к PostgreSQL. */

/** Назначение: роль → интеграция (коннектор). */
export interface RoleConnection {
  id: string;
  /** Название роли, напр. «Разработчик». */
  role: string;
  /** id интеграции из раздела «Интеграции» (или '' если не выбрано). */
  integrationId: string;
}

/**
 * Именованное дополнительное подключение к базе данных.
 * Источник истины — сервер (databasesApi → /api/additional-databases). Пароль/секрет
 * хранится только на сервере и не приходит клиенту (см. databasesApi, флаг hasSecret).
 * Основная (рабочая) БД PostgreSQL живёт на реальном backend (см. settingsApi).
 */
export interface DatabaseConnection {
  id: string;
  /** Отображаемое имя подключения, напр. «Аналитическая БД». */
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: PgSslMode;
}

/**
 * Реально подключённая БД, как её отдаёт backend `GET /api/databases`.
 * БЕЗ пароля (hasPassword). Доступна только для чтения — параметры задаются
 * на сервере (основная PostgreSQL — в секции выше / через переменные окружения).
 */
export interface ConnectedDatabase {
  id: string;
  kind: 'primary';
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: PgSslMode;
  hasPassword: boolean;
  status: {
    connected: boolean;
    tables: number | null;
    error: string | null;
  };
}

export type PgSslMode = 'disable' | 'require' | 'verify-full';

export const PG_SSL_LABEL: Record<PgSslMode, string> = {
  disable: 'Выключен',
  require: 'Требуется (require)',
  'verify-full': 'Проверка сертификата (verify-full)',
};

/**
 * Настройки подключения к PostgreSQL — БЕЗ пароля.
 * Контракт совпадает с backend `redactSettings`: сервер никогда не отдаёт
 * пароль клиенту, вместо него приходит флаг `hasPassword`.
 */
export interface PgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Служебная БД для CREATE DATABASE (есть в backend). */
  adminDatabase: string;
  sslMode: PgSslMode;
  /** Установлен ли пароль на сервере (пароль сам не передаётся). */
  hasPassword: boolean;
}

/**
 * Данные формы PostgreSQL. Пароль присутствует ТОЛЬКО в момент отправки на
 * backend и никогда не сохраняется в localStorage и не логируется.
 * Пустой пароль при сохранении = «не менять сохранённый» (см. backend mergeSettings).
 */
export interface PgFormValues {
  host: string;
  port: string;
  database: string;
  user: string;
  adminDatabase: string;
  sslMode: PgSslMode;
  password: string;
}
