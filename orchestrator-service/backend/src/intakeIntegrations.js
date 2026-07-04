// INTAKE-INTEGRATIONS-001 — реестр интеграций-источников обращений (третий канал
// приёма роли Task Intake Officer). Интеграция = зарегистрированное внешнее
// приложение-источник обращений о проблемах: название, токен доступа (хранится
// только как SHA-256 hex; сам токен наружу не отдаётся), признак включена/выключена,
// анти-спам лимиты (rate-limit по интеграции и по пользователю, минимальная длина
// сообщения). БЕЗ обязательной привязки к проекту — проект определяет Приёмщик.
//
// Не смешивать с «Движком» роли и коннекторами (connectors.js): движок — чем роль
// думает; интеграции обращений — откуда приходят обращения.
//
// Модуль самодостаточен по подключению к БД (собственный withClient, как в
// connectors.js), чтобы не образовать цикл импорта с db.js — db.js использует лишь
// чистую функцию hashToken.
import { createHash, randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadSettings } from './config.js';

const { Client } = pg;

let createClient = (cfg) => new Client(cfg);

// --- Тестовый помощник: подменить фабрику pg-клиента (как в connectors.js). ---
export function __setClientFactoryForTest(factory) {
  createClient = factory ?? ((cfg) => new Client(cfg));
}

function httpError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

function clientConfig(s) {
  return { host: s.host, port: s.port, user: s.user, password: s.password, database: s.database };
}

async function withClient(fn) {
  const s = await loadSettings();
  const client = createClient(clientConfig(s));
  client.on('error', (err) => {
    console.error(`[orchestrator-service] DB client error (intake-integrations, не фатально): ${err.message}`);
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.end();
    } catch (endErr) {
      console.error(`[orchestrator-service] DB client.end() error (intake-integrations, игнор): ${endErr.message}`);
    }
  }
}

// --- Токен доступа ----------------------------------------------------------
// Хэш токена (SHA-256 hex). Чистая функция: используется и здесь, и в db.js при
// авторизации приёма обращения по заголовку. Пустой/непереданный токен → ''.
export function hashToken(token) {
  const t = String(token ?? '').trim();
  if (!t) return '';
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

// Сгенерировать новый секретный токен интеграции (URL-safe hex, 48 байт).
export function generateToken() {
  return `itk_${randomBytes(24).toString('hex')}`;
}

const COLUMNS = `id, name, token_hash, enabled, rate_limit_per_min,
  user_rate_limit_per_min, min_message_length, created_at, updated_at`;

function rowToIntegration(r) {
  return {
    id: r.id,
    name: r.name,
    tokenHash: r.token_hash,
    enabled: r.enabled,
    rateLimitPerMin: r.rate_limit_per_min,
    userRateLimitPerMin: r.user_rate_limit_per_min,
    minMessageLength: r.min_message_length,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Наружу токен-хэш не отдаём — только флаг наличия токена.
export function redactIntegration(i) {
  const { tokenHash, ...rest } = i;
  return { ...rest, hasToken: Boolean(String(tokenHash ?? '').trim()) };
}

function clampInt(value, { def, min = 0, max = 1000000 }) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(Math.max(n, min), max);
}

// Нормализация входа CRUD. partial=true (обновление) — трогаем только присланные
// поля. Токен здесь НЕ задаётся: он выпускается генератором при создании/ротации.
export function normalizeIntegrationInput(input, { partial = false } = {}) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  if (!partial || src.name !== undefined) out.name = String(src.name ?? '').trim();
  if (!partial || src.enabled !== undefined) out.enabled = src.enabled !== false;
  if (!partial || src.rateLimitPerMin !== undefined) {
    out.rateLimitPerMin = clampInt(src.rateLimitPerMin, { def: 60, min: 1, max: 100000 });
  }
  if (!partial || src.userRateLimitPerMin !== undefined) {
    out.userRateLimitPerMin = clampInt(src.userRateLimitPerMin, { def: 20, min: 1, max: 100000 });
  }
  if (!partial || src.minMessageLength !== undefined) {
    out.minMessageLength = clampInt(src.minMessageLength, { def: 10, min: 0, max: 100000 });
  }
  return out;
}

export async function listIntegrations() {
  return withClient(async (c) => {
    const r = await c.query(`SELECT ${COLUMNS} FROM intake_integrations ORDER BY lower(name) ASC`);
    return r.rows.map((row) => redactIntegration(rowToIntegration(row)));
  });
}

async function getRow(c, id) {
  const r = await c.query(`SELECT ${COLUMNS} FROM intake_integrations WHERE id = $1`, [id]);
  if (!r.rowCount) throw httpError(404, 'intake_integration_not_found');
  return rowToIntegration(r.rows[0]);
}

export async function getIntegration(id) {
  return withClient(async (c) => redactIntegration(await getRow(c, id)));
}

// Создать интеграцию и сразу выпустить токен. ВАЖНО: plaintext-токен возвращается
// РОВНО ОДИН РАЗ (в поле token) — на сервере хранится только его хэш.
export async function createIntegration(input) {
  const v = normalizeIntegrationInput(input);
  if (!v.name) throw httpError(422, 'name_required');
  const token = generateToken();
  return withClient(async (c) => {
    let r;
    try {
      r = await c.query(
        `INSERT INTO intake_integrations
           (name, token_hash, enabled, rate_limit_per_min, user_rate_limit_per_min, min_message_length)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING ${COLUMNS}`,
        [v.name, hashToken(token), v.enabled ?? true, v.rateLimitPerMin ?? 60,
         v.userRateLimitPerMin ?? 20, v.minMessageLength ?? 10],
      );
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'intake_integration_name_exists');
      throw e;
    }
    return { ...redactIntegration(rowToIntegration(r.rows[0])), token };
  });
}

// FEEDBACK-WIDGET-001 — автопровижининг служебной интеграции по фиксированному
// ИМЕНИ с server-side секретом (канал виджета «Обратная связь» UI оркестратора).
// В отличие от createIntegration (сама генерирует токен и падает на дубле имени),
// секрет здесь задаёт сервер (env/пер-процессный), а вызов идемпотентен:
//   • записи нет   → создаём (enabled=true);
//   • запись есть  → синхронизируем ТОЛЬКО token_hash; enabled НЕ трогаем, чтобы
//     не переопределять ручное выключение интеграции администратором.
export async function ensureIntegrationWithToken(name, token, { enabled = true } = {}) {
  const nm = String(name ?? '').trim();
  if (!nm) throw httpError(422, 'name_required');
  const tokenHash = hashToken(token);
  if (!tokenHash) throw httpError(422, 'token_required');
  return withClient(async (c) => {
    const r = await c.query(
      `INSERT INTO intake_integrations (name, token_hash, enabled)
            VALUES ($1, $2, $3)
       ON CONFLICT (lower(name)) DO UPDATE
            SET token_hash = EXCLUDED.token_hash, updated_at = now()
         RETURNING ${COLUMNS}`,
      [nm, tokenHash, enabled],
    );
    return redactIntegration(rowToIntegration(r.rows[0]));
  });
}

export async function updateIntegration(id, input) {
  const v = normalizeIntegrationInput(input, { partial: true });
  return withClient(async (c) => {
    const existing = await getRow(c, id);
    const next = { ...existing, ...v };
    let r;
    try {
      r = await c.query(
        `UPDATE intake_integrations
            SET name = $2, enabled = $3, rate_limit_per_min = $4,
                user_rate_limit_per_min = $5, min_message_length = $6, updated_at = now()
          WHERE id = $1
          RETURNING ${COLUMNS}`,
        [id, next.name, next.enabled, next.rateLimitPerMin, next.userRateLimitPerMin, next.minMessageLength],
      );
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'intake_integration_name_exists');
      throw e;
    }
    return redactIntegration(rowToIntegration(r.rows[0]));
  });
}

// Перевыпуск токена: старый токен немедленно перестаёт работать. Новый plaintext
// возвращается один раз (в поле token).
export async function rotateIntegrationToken(id) {
  const token = generateToken();
  return withClient(async (c) => {
    await getRow(c, id); // 404, если интеграции нет
    const r = await c.query(
      `UPDATE intake_integrations SET token_hash = $2, updated_at = now()
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, hashToken(token)],
    );
    return { ...redactIntegration(rowToIntegration(r.rows[0])), token };
  });
}

export async function deleteIntegration(id) {
  return withClient(async (c) => {
    // tasks.intake_integration_id имеет ON DELETE SET NULL — принятые задачи не теряются.
    const r = await c.query('DELETE FROM intake_integrations WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'intake_integration_not_found');
    return { deleted: true };
  });
}

// Статистика принятых обращений по интеграциям-источникам (требование 6).
// total — всего принято, last24h — за сутки, lastReportAt — последнее обращение.
export async function getIntakeStats() {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT ii.id, ii.name, ii.enabled,
              count(t.id)::int AS total,
              count(t.id) FILTER (WHERE t.created_at > now() - interval '24 hours')::int AS last24h,
              max(t.created_at) AS last_report_at
         FROM intake_integrations ii
         LEFT JOIN tasks t ON t.intake_integration_id = ii.id
        GROUP BY ii.id, ii.name, ii.enabled
        ORDER BY total DESC, lower(ii.name) ASC`,
    );
    const integrations = r.rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      total: row.total,
      last24h: row.last24h,
      lastReportAt: row.last_report_at,
    }));
    return {
      integrations,
      totalReports: integrations.reduce((acc, i) => acc + i.total, 0),
    };
  });
}
