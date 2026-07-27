// Ядро работы с PostgreSQL: конфиг подключения, обёртки withClient/publicTx,
// проверка соединения, автосоздание БД, накат миграций/seed и статус БД.
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../../../shared/logging/index.js';

const log = createLogger({ service: 'orchestrator-service' });

const { Client } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

export const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || resolve(__dirname, '../db/migrations');
export const SEED_DIR = process.env.SEED_DIR || resolve(__dirname, '../db/seed');

export function clientConfig(s, database) {
  return {
    host: s.host,
    port: s.port,
    user: s.user,
    password: s.password,
    database: database || s.database,
  };
}

function assertIdentifier(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Недопустимое имя базы данных: "${name}"`);
  }
}

export async function withClient(cfg, fn) {
  const client = new Client(cfg);
  // DB-CONN-RESILIENCE-001: node-postgres эмитит на Client событие 'error' при
  // обрыве соединения (Patroni/PgBouncer/HAProxy периодически рвут коннект при
  // переключении лидера). Без слушателя 'error' Node роняет ВЕСЬ процесс
  // («Unhandled 'error' event»), и контейнер уходит в рестарт-луп. Слушатель
  // делает обрыв нефатальным: in-flight запрос всё равно отклонится и будет
  // обработан вызывающим (tick runner'а ловит ошибку и повторит на след. тике).
  client.on('error', (err) => {
    log.warn('DB client error (не фатально)', { event_code: 'DB_QUERY_FAILED', operation: 'db.client', error_code: 'DB_UNAVAILABLE', err });
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    // end() сам может бросить, если соединение уже оборвано — это не должно
    // маскировать исходную ошибку и не должно ронять процесс.
    try {
      await client.end();
    } catch (endErr) {
      log.warn('DB client.end() error (игнор)', { event_code: 'DB_QUERY_FAILED', operation: 'db.client.end', err: endErr });
    }
  }
}

// Фабрика тонких публичных обёрток над *Tx: открыть клиент по настройкам (s) и
// выполнить транзакционную функцию с этим клиентом, пробросив остальные аргументы
// как есть. Заменяет ~десяток идентичных однострочных обёрток
//   export async function foo(s, ...args) { return withClient(clientConfig(s), (c) => fooTx(c, ...args)); }
// Только для обёрток БЕЗ доп. логики (те, что до/после вызова что-то делают, оставлены как есть).
export const publicTx = (fn) => (s, ...args) => withClient(clientConfig(s), (c) => fn(c, ...args));

// Резолв id роли по её коду. Инлайн-форма
//   (await c.query('SELECT id FROM roles WHERE code = $1', [x])).rows[0]?.id ?? null
// повторялась в advanceOne/host/reasoning-путях — сведена в один хелпер.
// Нет роли с таким кодом → null (вызывающий сам решает, что делать).
export async function roleIdByCode(c, code) {
  return (await c.query('SELECT id FROM roles WHERE code = $1', [code])).rows[0]?.id ?? null;
}

// Проверка подключения к серверу + существует ли целевая БД.
export async function testConnection(s) {
  return withClient(clientConfig(s, s.adminDatabase), async (c) => {
    const v = await c.query('SELECT version() AS version');
    const ex = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [s.database]);
    return {
      ok: true,
      serverVersion: v.rows[0].version,
      database: s.database,
      databaseExists: ex.rowCount > 0,
    };
  });
}

// «Создать базу, если её нет».
export async function ensureDatabase(s) {
  assertIdentifier(s.database);
  return withClient(clientConfig(s, s.adminDatabase), async (c) => {
    const ex = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [s.database]);
    if (ex.rowCount > 0) return { created: false };
    await c.query(`CREATE DATABASE "${s.database}"`);
    return { created: true };
  });
}

// Накат миграций. Идемпотентно: отслеживаем применённые файлы в _schema_migrations.
export async function runMigrations(s) {
  return withClient(clientConfig(s), async (c) => {
    await c.query(`CREATE TABLE IF NOT EXISTS _schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now())`);
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      const done = await c.query('SELECT 1 FROM _schema_migrations WHERE filename = $1', [f]);
      if (done.rowCount > 0) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, f), 'utf8');
      await c.query(sql);
      await c.query('INSERT INTO _schema_migrations(filename) VALUES ($1)', [f]);
      applied.push(f);
    }
    return { applied };
  });
}

// Загрузка примеров данных (seed). Сид-файлы написаны идемпотентно (ON CONFLICT).
export async function runSeed(s) {
  return withClient(clientConfig(s), async (c) => {
    const files = (await readdir(SEED_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const applied = [];
    for (const f of files) {
      const sql = await readFile(join(SEED_DIR, f), 'utf8');
      await c.query(sql);
      applied.push(f);
    }
    return { applied };
  });
}

// Полная инициализация: создать БД (если нет) + накатить миграции.
export async function bootstrap(s) {
  const db = await ensureDatabase(s);
  const mig = await runMigrations(s);
  return { created: db.created, migrated: mig.applied };
}

// Текущее состояние целевой БД (для дашборда).
export async function getStatus(s) {
  try {
    return await withClient(clientConfig(s), async (c) => {
      const t = await c.query(
        `SELECT count(*)::int AS n FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      const m = await c
        .query('SELECT filename FROM _schema_migrations ORDER BY filename')
        .catch(() => ({ rows: [] }));
      const counts = {};
      for (const tbl of ['projects', 'services', 'roles', 'agents', 'tasks']) {
        const r = await c
          .query(`SELECT count(*)::int AS n FROM ${tbl}`)
          .catch(() => ({ rows: [{ n: null }] }));
        counts[tbl] = r.rows[0].n;
      }
      return {
        connected: true,
        database: s.database,
        tables: t.rows[0].n,
        migrations: m.rows.map((r) => r.filename),
        rowCounts: counts,
      };
    });
  } catch (e) {
    return { connected: false, database: s.database, error: e.message };
  }
}

/**
 * Список РЕАЛЬНО применённых миграций БД. Источник истины учёта — таблица
 * `_schema_migrations` (filename PK + applied_at), которую ведёт runMigrations:
 * каждый накатанный файл из db/migrations попадает туда ровно один раз.
 * Возвращает { count, migrations: [{ filename, appliedAt }] } в порядке filename.
 */
export async function getAppliedMigrations(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c
      .query('SELECT filename, applied_at FROM _schema_migrations ORDER BY filename')
      .catch(() => ({ rows: [] }));
    const migrations = r.rows.map((row) => ({
      filename: row.filename,
      appliedAt: row.applied_at,
    }));
    return { count: migrations.length, migrations };
  });
}
