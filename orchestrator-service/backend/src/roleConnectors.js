// LEGACY-BUSINESS-STORAGE-API-001 — назначения «роль → коннектор (AI)».
// role_connectors: role_code (канонический код роли) → connectors.id. Один
// коннектор на код роли. connectorId:null снимает назначение (строку оставляем).
import { withClient, clientConfig } from './db.js';

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function mapAssignment(row) {
  return {
    roleCode: row.role_code,
    connectorId: row.connector_id ?? null,
    updatedAt: toIso(row.updated_at),
  };
}

/**
 * ЧИСТАЯ нормализация + валидация входа массового сохранения.
 * Вход: { assignments:[{roleCode, connectorId|null}] }.
 * validRoleCodes/validConnectorIds — Set допустимых значений (из БД).
 * Бросает httpError(422, role_connector_invalid_role|role_connector_invalid_connector).
 * Возвращает дедуплицированный список { roleCode, connectorId|null } (последнее
 * значение по roleCode побеждает). roleCode тримится; пустые — пропускаются.
 */
export function normalizeRoleConnectors(input, { validRoleCodes, validConnectorIds }) {
  const list = Array.isArray(input?.assignments) ? input.assignments : [];
  const byRole = new Map();
  for (const item of list) {
    const roleCode = String(item?.roleCode ?? '').trim();
    if (!roleCode) continue;
    if (validRoleCodes && !validRoleCodes.has(roleCode)) {
      throw httpError(422, 'role_connector_invalid_role', { code: 'role_connector_invalid_role' });
    }
    const rawId = item?.connectorId;
    const connectorId = rawId === null || rawId === undefined || rawId === '' ? null : String(rawId);
    if (connectorId !== null && validConnectorIds && !validConnectorIds.has(connectorId)) {
      throw httpError(422, 'role_connector_invalid_connector', { code: 'role_connector_invalid_connector' });
    }
    byRole.set(roleCode, connectorId);
  }
  return [...byRole.entries()].map(([roleCode, connectorId]) => ({ roleCode, connectorId }));
}

export async function listRoleConnectors(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'SELECT role_code, connector_id, updated_at FROM role_connectors ORDER BY role_code',
    );
    return { assignments: r.rows.map(mapAssignment) };
  });
}

/**
 * PUT /api/role-connectors — массовый upsert. connectorId:null снимает (пишем
 * строку с connector_id=NULL). Валидация: roleCode ∈ roles, connectorId ∈
 * connectors (если не null). Возврат: актуальный полный список назначений.
 */
export async function saveRoleConnectors(s, input) {
  return withClient(clientConfig(s), async (c) => {
    const roles = await c.query('SELECT code FROM roles');
    const validRoleCodes = new Set(roles.rows.map((r) => r.code));
    const connectors = await c.query('SELECT id::text AS id FROM connectors');
    const validConnectorIds = new Set(connectors.rows.map((r) => r.id));

    const normalized = normalizeRoleConnectors(input, { validRoleCodes, validConnectorIds });

    await c.query('BEGIN');
    try {
      for (const { roleCode, connectorId } of normalized) {
        await c.query(
          `INSERT INTO role_connectors (role_code, connector_id, updated_at)
           VALUES ($1, $2, now())
           ON CONFLICT (role_code)
           DO UPDATE SET connector_id = EXCLUDED.connector_id, updated_at = now()`,
          [roleCode, connectorId],
        );
      }
      const r = await c.query(
        'SELECT role_code, connector_id, updated_at FROM role_connectors ORDER BY role_code',
      );
      await c.query('COMMIT');
      return { assignments: r.rows.map(mapAssignment) };
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}
