// Список РЕАЛЬНО подключённых БД оркестратора (для карточек в UI).
// Сейчас источник истины один — основная PostgreSQL из настроек (config.js).
// Структура ответа — массив, чтобы later можно было добавить дополнительные
// зарегистрированные подключения без слома контракта. Пароль НЕ отдаётся
// (redactSettings → hasPassword), статус берём «вживую» через getStatus.
import { redactSettings } from './config.js';
import { getStatus } from './db.js';

export const PRIMARY_DB_ID = 'primary-postgres';

/**
 * GET /api/databases — перечень подключённых БД с живым статусом.
 * Ничего не изменяет. Возвращает { databases: [...] } без секретов.
 * `getStatusFn` инъектируется для тестов (по умолчанию — реальный getStatus).
 */
export async function listDatabases(settings, getStatusFn = getStatus) {
  const redacted = redactSettings(settings);
  const status = await getStatusFn(settings);
  const primary = {
    id: PRIMARY_DB_ID,
    kind: 'primary',
    name: `PostgreSQL — ${settings.database}`,
    host: settings.host,
    port: settings.port,
    database: settings.database,
    user: settings.user,
    sslMode: settings.sslMode ?? 'disable',
    hasPassword: redacted.hasPassword,
    status: {
      connected: Boolean(status.connected),
      tables: status.tables ?? null,
      error: status.error ?? null,
    },
  };
  return { databases: [primary] };
}
