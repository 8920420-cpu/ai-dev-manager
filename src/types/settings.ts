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
 * ⚠️ Хранится локально (localStorage) — БЕЗ пароля/секретов (см. databasesApi).
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
