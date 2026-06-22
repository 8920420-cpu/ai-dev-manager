// LEGACY-BUSINESS-STORAGE-API-001 — дополнительные подключения к БД.
// Глобальный справочник доп. подключений (additional_databases). secret (пароль)
// хранится ТОЛЬКО на сервере и НИКОГДА не возвращается клиенту — в ответах лишь
// флаг hasSecret. Образец редакции — databases.js/connectors.js (hasPassword/hasToken).
import { withClient, clientConfig } from './db.js';

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

const COLUMNS =
  'id, name, host, port, database, db_user, ssl_mode, secret, created_at, updated_at';

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

/**
 * ЧИСТАЯ редакция строки additional_databases → контракт записи. secret НИКОГДА
 * не попадает в результат: вместо него флаг hasSecret. db_user → user, ssl_mode
 * → sslMode. Тестируется без БД.
 */
export function redactAdditionalDb(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    host: row.host ?? '',
    port: row.port ?? 5432,
    database: row.database ?? '',
    user: row.db_user ?? '',
    sslMode: row.ssl_mode ?? 'disable',
    hasSecret: Boolean(String(row.secret ?? '').trim()),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

// Нормализация входа. partial=true (update) — обновляем только переданные ключи.
// password пишется в secret; пустой/отсутствующий password при update = не менять.
function normalizeInput(input, { partial = false } = {}) {
  const out = {};
  const str = (v) => String(v ?? '').trim();
  if (!partial || input?.name !== undefined) out.name = str(input?.name);
  if (!partial || input?.host !== undefined) out.host = str(input?.host);
  if (!partial || input?.port !== undefined) out.port = Number(input?.port) || 5432;
  if (!partial || input?.database !== undefined) out.database = str(input?.database);
  if (!partial || input?.user !== undefined) out.db_user = str(input?.user);
  if (!partial || input?.sslMode !== undefined) out.ssl_mode = str(input?.sslMode) || 'disable';
  // secret: пишем только если передан непустой password (иначе — не менять).
  if (input?.password !== undefined && str(input?.password) !== '') {
    out.secret = str(input.password);
  }
  return out;
}

export async function listAdditionalDatabases(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(`SELECT ${COLUMNS} FROM additional_databases ORDER BY lower(name), created_at`);
    return { databases: r.rows.map(redactAdditionalDb) };
  });
}

async function getRow(c, id) {
  const r = await c.query(`SELECT ${COLUMNS} FROM additional_databases WHERE id = $1`, [id]);
  if (!r.rowCount) throw httpError(404, 'additional_database_not_found', { code: 'additional_database_not_found' });
  return r.rows[0];
}

export async function getAdditionalDatabase(s, id) {
  return withClient(clientConfig(s), async (c) => redactAdditionalDb(await getRow(c, id)));
}

export async function createAdditionalDatabase(s, input) {
  const v = normalizeInput(input);
  if (!v.name) throw httpError(422, 'additional_database_name_required', { code: 'additional_database_name_required' });
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `INSERT INTO additional_databases (name, host, port, database, db_user, ssl_mode, secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${COLUMNS}`,
      [v.name, v.host ?? '', v.port ?? 5432, v.database ?? '', v.db_user ?? '',
       v.ssl_mode ?? 'disable', v.secret ?? null],
    );
    return redactAdditionalDb(r.rows[0]);
  });
}

export async function updateAdditionalDatabase(s, id, input) {
  const v = normalizeInput(input, { partial: true });
  if (v.name !== undefined && v.name === '') {
    throw httpError(422, 'additional_database_name_required', { code: 'additional_database_name_required' });
  }
  return withClient(clientConfig(s), async (c) => {
    await getRow(c, id); // 404, если нет
    const keys = Object.keys(v);
    if (!keys.length) return redactAdditionalDb(await getRow(c, id));
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const params = [id, ...keys.map((k) => v[k])];
    const r = await c.query(
      `UPDATE additional_databases SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      params,
    );
    return redactAdditionalDb(r.rows[0]);
  });
}

export async function deleteAdditionalDatabase(s, id) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query('DELETE FROM additional_databases WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'additional_database_not_found', { code: 'additional_database_not_found' });
    return { deleted: true };
  });
}
