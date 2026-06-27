// DATABASE-CONNECTIONS-001 (ORCHESTRATOR-P1.4) — единый CRUD пользовательских
// подключений к БД. Без деления «основная»/«дополнительная»: все доступные
// проекту БД — записи database_connections. Внутреннее инфраструктурное
// подключение оркестратора (config.js) здесь НЕ присутствует.
//
// secret (пароль) хранится только на сервере и НИКОГДА не возвращается клиенту
// (в ответах — hasSecret). Строка подключения и пароль не попадают в ошибки/логи.
import pg from 'pg';
import { withClient, clientConfig } from './db.js';

const { Client } = pg;

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  if (extra) Object.assign(error, extra);
  return error;
}

const COLUMNS =
  'id, name, dbms_type, host, port, database, db_user, ssl_mode, secret, created_at, updated_at';

const SUPPORTED_DBMS = new Set(['postgres']);

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

// --- Чистые функции (без БД/сети) — покрыты юнит-тестами --------------------

/**
 * ЧИСТАЯ редакция строки → контракт подключения. secret НИКОГДА не попадает в
 * результат (вместо него hasSecret). Без категории primary/additional.
 */
export function redactConnection(row) {
  return {
    id: row.id,
    name: row.name ?? '',
    dbmsType: row.dbms_type ?? 'postgres',
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

/**
 * Нормализация входа. partial=true (update) — только переданные ключи; пустой/
 * отсутствующий password при update = сохранить существующий секрет (не писать).
 */
export function normalizeConnectionInput(input, { partial = false } = {}) {
  const out = {};
  const str = (v) => String(v ?? '').trim();
  if (!partial || input?.name !== undefined) out.name = str(input?.name);
  if (!partial || input?.dbmsType !== undefined) {
    const t = str(input?.dbmsType) || 'postgres';
    if (!SUPPORTED_DBMS.has(t)) throw httpError(422, 'database_connection_unsupported_dbms', { dbms: t });
    out.dbms_type = t;
  }
  if (!partial || input?.host !== undefined) out.host = str(input?.host);
  if (!partial || input?.port !== undefined) out.port = Number(input?.port) || 5432;
  if (!partial || input?.database !== undefined) out.database = str(input?.database);
  if (!partial || input?.user !== undefined) out.db_user = str(input?.user);
  if (!partial || input?.sslMode !== undefined) out.ssl_mode = str(input?.sslMode) || 'disable';
  // secret: писать только при непустом password (иначе — не менять).
  if (input?.password !== undefined && str(input?.password) !== '') {
    out.secret = str(input.password);
  }
  return out;
}

/**
 * ЧИСТОЕ правило выбора БД проекта по единой модели подключений.
 * databaseId — переданное значение (string|null|''|undefined); availableIds —
 * список существующих id подключений.
 *   * передан null/'' → проект без БД (null);
 *   * передан id → должен существовать (иначе 422 project_database_unknown);
 *   * не передан (undefined): 1 подключение → оно по умолчанию; >1 → 422
 *     project_database_selection_required; 0 → проект без БД (null).
 * Возвращает выбранный database_ref (string|null).
 */
export function resolveProjectDatabaseRef(databaseId, availableIds = []) {
  const ids = availableIds.map(String);
  if (databaseId !== undefined) {
    if (databaseId === null || databaseId === '') return null;
    const id = String(databaseId);
    if (!ids.includes(id)) throw httpError(422, 'project_database_unknown', { databaseId: id });
    return id;
  }
  if (ids.length === 1) return ids[0];
  if (ids.length > 1) throw httpError(422, 'project_database_selection_required');
  return null;
}

// --- DB: CRUD ----------------------------------------------------------------

export async function listConnections(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(`SELECT ${COLUMNS} FROM database_connections ORDER BY lower(name), created_at`);
    return { connections: r.rows.map(redactConnection) };
  });
}

async function getRow(c, id) {
  const r = await c.query(`SELECT ${COLUMNS} FROM database_connections WHERE id = $1`, [id]);
  if (!r.rowCount) throw httpError(404, 'database_connection_not_found');
  return r.rows[0];
}

export async function getConnection(s, id) {
  return withClient(clientConfig(s), async (c) => redactConnection(await getRow(c, id)));
}

export async function createConnection(s, input) {
  const v = normalizeConnectionInput(input);
  if (!v.name) throw httpError(422, 'database_connection_name_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `INSERT INTO database_connections (name, dbms_type, host, port, database, db_user, ssl_mode, secret)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [v.name, v.dbms_type ?? 'postgres', v.host ?? '', v.port ?? 5432, v.database ?? '',
       v.db_user ?? '', v.ssl_mode ?? 'disable', v.secret ?? null],
    );
    return redactConnection(r.rows[0]);
  });
}

export async function updateConnection(s, id, input) {
  const v = normalizeConnectionInput(input, { partial: true });
  if (v.name !== undefined && v.name === '') throw httpError(422, 'database_connection_name_required');
  return withClient(clientConfig(s), async (c) => {
    await getRow(c, id); // 404, если нет
    const keys = Object.keys(v);
    if (!keys.length) return redactConnection(await getRow(c, id));
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const params = [id, ...keys.map((k) => v[k])];
    const r = await c.query(
      `UPDATE database_connections SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      params,
    );
    return redactConnection(r.rows[0]);
  });
}

/**
 * Удаление запрещено, если подключение используется проектами: стабильная
 * 409-ошибка со списком/количеством зависимостей. Каскадного обнуления нет.
 */
export async function deleteConnection(s, id) {
  return withClient(clientConfig(s), async (c) => {
    await getRow(c, id); // 404, если нет
    const deps = await c.query(
      'SELECT id, code, name FROM projects WHERE database_ref = $1 ORDER BY lower(name)',
      [String(id)],
    );
    if (deps.rowCount) {
      throw httpError(409, 'database_connection_in_use', {
        count: deps.rowCount,
        dependents: deps.rows.map((p) => ({ id: p.id, code: p.code, name: p.name })),
      });
    }
    await c.query('DELETE FROM database_connections WHERE id = $1', [id]);
    return { deleted: true };
  });
}

/**
 * Проверка соединения по сохранённым реквизитам подключения. Ничего не пишет.
 * Возвращает { connected, error|null } — error без строки подключения и пароля.
 */
export async function testConnectionById(s, id) {
  return withClient(clientConfig(s), async (c) => {
    const row = await getRow(c, id);
    const client = new Client({
      host: row.host || '127.0.0.1',
      port: row.port || 5432,
      user: row.db_user || 'postgres',
      password: row.secret ?? '',
      database: row.database || 'postgres',
      ssl: row.ssl_mode && row.ssl_mode !== 'disable' ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 5000,
    });
    // DB-CONN-RESILIENCE-001: обрыв проверочного соединения не должен ронять процесс.
    client.on('error', () => {});
    try {
      await client.connect();
      await client.query('SELECT 1');
      return { connected: true, error: null };
    } catch (e) {
      // Безопасное сообщение: код ошибки pg без реквизитов/строки подключения.
      return { connected: false, error: safeDbError(e) };
    } finally {
      try { await client.end(); } catch { /* already closed */ }
    }
  });
}

// Привести ошибку подключения к безопасному виду (без секретов/хоста/строки).
function safeDbError(e) {
  if (e && e.code) return `db_error:${e.code}`;
  const msg = String(e?.message ?? 'connection_failed');
  // Не пропускаем потенциальные реквизиты — отдаём обобщённый класс ошибки.
  if (/password|authentication/i.test(msg)) return 'authentication_failed';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg)) return 'host_unreachable';
  if (/ECONNREFUSED/i.test(msg)) return 'connection_refused';
  if (/timeout/i.test(msg)) return 'connection_timeout';
  return 'connection_failed';
}
