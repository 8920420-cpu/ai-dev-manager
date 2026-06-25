// Реестр коннекторов + журнал обмена. Аналог connector_service:
// ConnectorRepository + PromptExchangeService (синхронный invoke вместо
// фонового диспетчера — обмен записывается в рамках одного запроса).
import pg from 'pg';
import { loadSettings } from './config.js';
import { invoke as llmInvoke } from './llmConnector.js';

const { Client } = pg;

// Статусы обмена — те же, что в источнике (ai.prompt_exchange).
export const EXCHANGE_STATUS = {
  CREATED: 'Создан',
  SENT: 'отправлен',
  COMPLETED: 'завершен',
  FAILED: 'ошибка',
};

// Реестр провайдеров: endpoint определяется самим коннектором, а не вводится
// вручную. Добавить нового провайдера = одна строка здесь.
export const PROVIDER_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
};

function endpointForProvider(provider) {
  const ep = PROVIDER_ENDPOINTS[provider];
  if (!ep) throw httpError(422, 'unknown_provider');
  return ep;
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
  const client = new Client(clientConfig(s));
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

const CONNECTOR_COLUMNS = `id, name, provider, endpoint, access_token, model,
  consumer_service, priority, is_enabled, created_at, updated_at`;

// Преобразование строки БД в объект коннектора (с access_token — для invoke).
function rowToConnector(r) {
  return {
    id: r.id,
    name: r.name,
    provider: r.provider,
    endpoint: r.endpoint,
    accessToken: r.access_token,
    model: r.model,
    consumerService: r.consumer_service,
    priority: r.priority,
    isEnabled: r.is_enabled,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// Версия без секрета — только её отдаём клиенту по сети.
export function redactConnector(c) {
  const { accessToken, ...rest } = c;
  return { ...rest, hasToken: Boolean(String(accessToken ?? '').trim()) };
}

function normalizeInput(input, { partial = false } = {}) {
  const out = {};
  const str = (v) => String(v ?? '').trim();
  if (!partial || input.name !== undefined) out.name = str(input.name);
  if (!partial || input.provider !== undefined) out.provider = str(input.provider) || 'deepseek';
  // endpoint вручную не задаётся — выводится из провайдера (см. ниже).
  if (!partial || input.model !== undefined) out.model = str(input.model);
  if (!partial || input.consumerService !== undefined) out.consumerService = str(input.consumerService);
  if (!partial || input.priority !== undefined) out.priority = Number(input.priority) || 100;
  if (!partial || input.isEnabled !== undefined) out.isEnabled = input.isEnabled !== false;
  // Пустой/отсутствующий token при обновлении = «не менять» (как пароль в config.js).
  if (input.accessToken !== undefined && str(input.accessToken) !== '') {
    out.accessToken = str(input.accessToken);
  } else if (!partial) {
    out.accessToken = str(input.accessToken);
  }
  return out;
}

export async function listConnectors() {
  return withClient(async (c) => {
    const r = await c.query(
      `SELECT ${CONNECTOR_COLUMNS} FROM connectors ORDER BY priority ASC, lower(name) ASC`,
    );
    return r.rows.map((row) => redactConnector(rowToConnector(row)));
  });
}

async function getRow(c, id) {
  const r = await c.query(`SELECT ${CONNECTOR_COLUMNS} FROM connectors WHERE id = $1`, [id]);
  if (!r.rowCount) throw httpError(404, 'connector_not_found');
  return rowToConnector(r.rows[0]);
}

export async function getConnector(id) {
  return withClient(async (c) => redactConnector(await getRow(c, id)));
}

export async function createConnector(input) {
  const v = normalizeInput(input);
  if (!v.name) throw httpError(422, 'name_required');
  v.endpoint = endpointForProvider(v.provider); // путь определяет провайдер
  return withClient(async (c) => {
    let r;
    try {
      r = await c.query(
        `INSERT INTO connectors
           (name, provider, endpoint, access_token, model, consumer_service, priority, is_enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${CONNECTOR_COLUMNS}`,
        [v.name, v.provider, v.endpoint, v.accessToken ?? '', v.model ?? '',
         v.consumerService ?? '', v.priority ?? 100, v.isEnabled ?? true],
      );
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'connector_name_exists');
      throw e;
    }
    return redactConnector(rowToConnector(r.rows[0]));
  });
}

export async function updateConnector(id, input) {
  const v = normalizeInput(input, { partial: true });
  return withClient(async (c) => {
    const existing = await getRow(c, id);
    const next = { ...existing, ...v };
    next.endpoint = endpointForProvider(next.provider); // путь определяет провайдер
    let r;
    try {
      r = await c.query(
        `UPDATE connectors
            SET name = $2, provider = $3, endpoint = $4, access_token = $5, model = $6,
                consumer_service = $7, priority = $8, is_enabled = $9, updated_at = now()
          WHERE id = $1
          RETURNING ${CONNECTOR_COLUMNS}`,
        [id, next.name, next.provider, next.endpoint, next.accessToken, next.model,
         next.consumerService, next.priority, next.isEnabled],
      );
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'connector_name_exists');
      throw e;
    }
    return redactConnector(rowToConnector(r.rows[0]));
  });
}

export async function deleteConnector(id) {
  return withClient(async (c) => {
    const r = await c.query('DELETE FROM connectors WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'connector_not_found');
    return { deleted: true };
  });
}

// Структурированный журнал обмена по коннектору.
export async function listExchanges(connectorId, { limit = 200 } = {}) {
  return withClient(async (c) => {
    await getRow(c, connectorId); // 404, если коннектора нет
    const r = await c.query(
      `SELECT id, connector_id, consumer_service, prompt, response, status,
              is_manual, error, http_status, duration_ms, created_at
         FROM prompt_exchanges
        WHERE connector_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [connectorId, Math.min(Math.max(Number(limit) || 200, 1), 1000)],
    );
    return r.rows.map((row) => ({
      id: row.id,
      connectorId: row.connector_id,
      consumerService: row.consumer_service,
      prompt: row.prompt,
      response: row.response,
      status: row.status,
      isManual: row.is_manual,
      error: row.error,
      httpStatus: row.http_status,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    }));
  });
}

/**
 * Вызвать ИИ через коннектор и записать обмен в журнал.
 * Канонический контракт: input = { system?, user?, isManual? }. Единственное
 * пользовательское поле — `user`; legacy-alias `input.prompt` удалён
 * (см. tasks → ORCHESTRATOR-P2.2). Старый payload `{ prompt }` без `user`/`system`
 * получает стабильную 422-ошибку `prompt_required`, а не молчаливо принимается.
 * Жизненный цикл записи: Создан → отправлен → завершен/ошибка (как в источнике).
 */
export async function invokeConnector(connectorId, input = {}) {
  const user = String(input.user ?? '').trim();
  const system = String(input.system ?? '').trim();
  if (user === '' && system === '') throw httpError(422, 'prompt_required');
  const isManual = input.isManual !== false; // вызовы через UI считаем ручными

  return withClient(async (c) => {
    const conn = await getRow(c, connectorId);
    if (!conn.isEnabled) throw httpError(409, 'connector_disabled');

    const promptText = system ? `${system}\n\n${user}` : user;
    const ins = await c.query(
      `INSERT INTO prompt_exchanges
         (connector_id, consumer_service, prompt, status, is_manual)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [connectorId, conn.consumerService ?? '', promptText, EXCHANGE_STATUS.SENT, isManual],
    );
    const exchangeId = ins.rows[0].id;

    try {
      const { text, httpStatus, durationMs } = await llmInvoke(conn, { system, user });
      const upd = await c.query(
        `UPDATE prompt_exchanges
            SET response = $2, status = $3, http_status = $4, duration_ms = $5
          WHERE id = $1
          RETURNING id, connector_id, consumer_service, prompt, response, status,
                    is_manual, error, http_status, duration_ms, created_at`,
        [exchangeId, text, EXCHANGE_STATUS.COMPLETED, httpStatus ?? null, durationMs ?? null],
      );
      const row = upd.rows[0];
      return {
        ok: true,
        response: text,
        exchange: {
          id: row.id,
          connectorId: row.connector_id,
          status: row.status,
          httpStatus: row.http_status,
          durationMs: row.duration_ms,
          createdAt: row.created_at,
        },
      };
    } catch (e) {
      await c.query(
        `UPDATE prompt_exchanges
            SET status = $2, error = $3, http_status = $4, duration_ms = $5
          WHERE id = $1`,
        [exchangeId, EXCHANGE_STATUS.FAILED, e.message, e.httpStatus ?? null, e.durationMs ?? null],
      );
      throw httpError(502, e.message);
    }
  });
}
