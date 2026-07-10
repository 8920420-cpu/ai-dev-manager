// ROLE-GROUPS-001 — смысловые группы ролей экрана «Настройки → Роли».
//
// Группа — управляемая сущность: создание, переименование, удаление, изменение
// порядка. Роль ссылается на группу через roles.group_id (миграция 0015); при
// удалении группы её роли возвращаются в «без группы» (group_id = NULL, в UI —
// «Прочее»). Раскладка по группам — только организация экрана ролей и НИКАК не
// влияет на рантайм пайплайна (пропуск роли настраивается per-project через
// project_stages.enabled).
import { withClient, clientConfig } from './db.js';

// Лимиты полей группы (защита от мусора).
export const ROLE_GROUP_LIMITS = {
  name: 120,
};

import { httpCodedError as httpError } from './httpError.js';

// --- Чистые функции (без БД) — покрыты юнит-тестами -------------------------

/**
 * ЧИСТАЯ валидация/нормализация имени группы. Возвращает обрезанную строку или
 * бросает httpError(422). Используется и при create, и при rename.
 */
export function normalizeGroupName(rawName) {
  const name = String(rawName ?? '').trim();
  if (!name) throw httpError(422, 'role_group_name_required');
  if (name.length > ROLE_GROUP_LIMITS.name) throw httpError(422, 'role_group_name_too_long');
  return name;
}

/**
 * ЧИСТАЯ нормализация sort_order: целое >= 0 или null (не передано → не меняем
 * при update / 0 по умолчанию при create — это решает вызывающий код).
 */
export function normalizeSortOrder(raw) {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw httpError(422, 'role_group_sort_order_invalid');
  return n;
}

function mapGroup(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
  };
}

// --- DB ----------------------------------------------------------------------

export async function listRoleGroups(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'SELECT id, name, sort_order FROM role_groups ORDER BY sort_order, name',
    );
    return { groups: r.rows.map(mapGroup) };
  });
}

/**
 * POST /api/role-groups — создать группу. Имя уникально без учёта регистра
 * (409 role_group_name_taken при конфликте). sort_order по умолчанию ставится
 * в конец списка (max+10), если не передан.
 */
export async function createRoleGroup(s, input) {
  const name = normalizeGroupName(input?.name);
  const sortOrder = normalizeSortOrder(input?.sortOrder);
  return withClient(clientConfig(s), async (c) => {
    try {
      const order =
        sortOrder ??
        ((await c.query('SELECT COALESCE(max(sort_order), 0) + 10 AS next FROM role_groups'))
          .rows[0].next);
      const r = await c.query(
        'INSERT INTO role_groups (name, sort_order) VALUES ($1, $2) RETURNING id, name, sort_order',
        [name, order],
      );
      return mapGroup(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'role_group_name_taken', { name });
      throw e;
    }
  });
}

/**
 * PUT /api/role-groups/:id — переименование и/или смена порядка. Меняются только
 * переданные поля. 404 если группы нет, 409 при конфликте имени.
 */
export async function updateRoleGroup(s, id, input) {
  const groupId = String(id ?? '').trim();
  if (!groupId) throw httpError(422, 'role_group_id_required');
  const sets = [];
  const params = [groupId];
  if (input && 'name' in input) {
    params.push(normalizeGroupName(input.name));
    sets.push(`name = $${params.length}`);
  }
  if (input && 'sortOrder' in input) {
    const order = normalizeSortOrder(input.sortOrder);
    if (order === null) throw httpError(422, 'role_group_sort_order_invalid');
    params.push(order);
    sets.push(`sort_order = $${params.length}`);
  }
  if (!sets.length) throw httpError(422, 'role_group_update_empty');
  sets.push('updated_at = now()');
  return withClient(clientConfig(s), async (c) => {
    try {
      const r = await c.query(
        `UPDATE role_groups SET ${sets.join(', ')} WHERE id = $1 RETURNING id, name, sort_order`,
        params,
      );
      if (!r.rowCount) throw httpError(404, 'role_group_not_found');
      return mapGroup(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'role_group_name_taken');
      throw e;
    }
  });
}

/**
 * DELETE /api/role-groups/:id — удалить группу. Роли группы возвращаются в
 * «без группы» (group_id = NULL) благодаря ON DELETE SET NULL. Возвращает число
 * затронутых (откреплённых) ролей для информативного UI.
 */
export async function deleteRoleGroup(s, id) {
  const groupId = String(id ?? '').trim();
  if (!groupId) throw httpError(422, 'role_group_id_required');
  return withClient(clientConfig(s), async (c) => {
    const affected = await c.query('SELECT count(*)::int AS n FROM roles WHERE group_id = $1', [
      groupId,
    ]);
    const r = await c.query('DELETE FROM role_groups WHERE id = $1', [groupId]);
    if (!r.rowCount) throw httpError(404, 'role_group_not_found');
    return { ok: true, detachedRoles: affected.rows[0].n };
  });
}
