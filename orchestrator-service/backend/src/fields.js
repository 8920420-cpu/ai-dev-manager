// ROLE-FIELD-CONTRACT-001 — API глобального справочника полей и контракта роли.
//
//   * /api/fields                — CRUD справочника полей (fields);
//   * /api/roles/:code/fields    — чтение/замена контракта роли (role_fields):
//                                  входящие (in) и исходящие (out) поля.
//
// Контракт роли необязателен. При ИЗМЕНЕНИИ контракта роли, уже задействованной
// во ВКЛЮЧЁННЫХ этапах какого-либо проекта, такие проекты ставятся на паузу
// (status='paused' + pause_reason) — требуется пересогласование полей этапов.
import { withClient, clientConfig } from './db.js';
import { withTransaction } from './transaction.js';

import { httpCodedError as httpError } from './httpError.js';

export const FIELD_VALUE_TYPES = ['text', 'number', 'boolean', 'list', 'json'];
const KEY_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

// --- Чистые helpers ---------------------------------------------------------

// Нормализовать/проверить вход поля справочника. partial=true → только переданные.
export function normalizeFieldInput(input, { partial = false } = {}) {
  if (input == null || typeof input !== 'object') throw httpError(422, 'field_invalid_body');
  const patch = {};
  if (!partial || 'key' in input) {
    const key = String(input.key ?? '').trim();
    if (!KEY_RE.test(key)) throw httpError(422, 'field_key_invalid', { key });
    patch.key = key;
  }
  if (!partial || 'name' in input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw httpError(422, 'field_name_required');
    if (name.length > 200) throw httpError(422, 'field_name_too_long');
    patch.name = name;
  }
  if ('description' in input) {
    patch.description = input.description == null ? null : String(input.description).slice(0, 2000);
  }
  if ('valueType' in input || 'value_type' in input) {
    const vt = String(input.valueType ?? input.value_type ?? 'text').trim().toLowerCase();
    if (!FIELD_VALUE_TYPES.includes(vt)) throw httpError(422, 'field_value_type_invalid', { valueType: vt });
    patch.value_type = vt;
  }
  return patch;
}

// Нормализовать контракт роли из запроса: { inputs:[ref], outputs:[ref] }, где
// ref — key поля (строка) или { key|field|fieldId|id, required }.
// Возвращает { inputs:[{ref,required}], outputs:[{ref,required}] }.
export function normalizeContractInput(input) {
  if (input == null || typeof input !== 'object') throw httpError(422, 'role_fields_invalid_body');
  const one = (item) => {
    if (typeof item === 'string') return { ref: item.trim(), required: true };
    const ref = String(item?.key ?? item?.field ?? item?.fieldId ?? item?.id ?? '').trim();
    return { ref, required: item?.required !== false };
  };
  const list = (x, dir) => {
    const arr = Array.isArray(x) ? x : [];
    const seen = new Set();
    const out = [];
    for (const item of arr) {
      const n = one(item);
      if (!n.ref) throw httpError(422, 'role_field_ref_required', { direction: dir });
      if (seen.has(n.ref)) throw httpError(422, 'role_field_duplicate', { direction: dir, ref: n.ref });
      seen.add(n.ref);
      out.push(n);
    }
    return out;
  };
  return { inputs: list(input.inputs, 'in'), outputs: list(input.outputs, 'out') };
}

function mapField(row) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description ?? '',
    valueType: row.value_type ?? 'text',
  };
}

// --- Справочник полей -------------------------------------------------------

export async function listFields(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query('SELECT id, key, name, description, value_type FROM fields ORDER BY key');
    return { fields: r.rows.map(mapField) };
  });
}

export async function createField(s, input) {
  const patch = normalizeFieldInput(input);
  return withClient(clientConfig(s), async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO fields (key, name, description, value_type)
         VALUES ($1, $2, $3, COALESCE($4, 'text'))
         RETURNING id, key, name, description, value_type`,
        [patch.key, patch.name, patch.description ?? null, patch.value_type ?? null],
      );
      return mapField(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'field_key_exists', { key: patch.key });
      throw e;
    }
  });
}

export async function updateField(s, id, input) {
  const patch = normalizeFieldInput(input, { partial: true });
  const keys = Object.keys(patch);
  return withClient(clientConfig(s), async (c) => {
    if (!keys.length) {
      const r = await c.query('SELECT id, key, name, description, value_type FROM fields WHERE id = $1', [id]);
      if (!r.rowCount) throw httpError(404, 'field_not_found');
      return mapField(r.rows[0]);
    }
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    try {
      const r = await c.query(
        `UPDATE fields SET ${sets.join(', ')} WHERE id = $1
         RETURNING id, key, name, description, value_type`,
        [id, ...keys.map((k) => patch[k])],
      );
      if (!r.rowCount) throw httpError(404, 'field_not_found');
      return mapField(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'field_key_exists', { key: patch.key });
      throw e;
    }
  });
}

export async function deleteField(s, id) {
  return withClient(clientConfig(s), async (c) => {
    // role_fields ссылается ON DELETE CASCADE — поле исчезнет из контрактов.
    const r = await c.query('DELETE FROM fields WHERE id = $1 RETURNING id', [id]);
    if (!r.rowCount) throw httpError(404, 'field_not_found');
    return { deleted: true };
  });
}

// --- Контракт роли ----------------------------------------------------------

async function roleIdByCode(c, code) {
  const r = await c.query('SELECT id FROM roles WHERE code = $1', [code]);
  if (!r.rowCount) throw httpError(404, 'role_not_found', { role: code });
  return r.rows[0].id;
}

// Прочитать контракт роли: { roleCode, inputs:[field+required], outputs:[...] }.
export async function getRoleFields(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required');
  return withClient(clientConfig(s), async (c) => {
    await roleIdByCode(c, roleCode);
    const r = await c.query(
      `SELECT rf.direction, rf.required, rf.position, f.id, f.key, f.name, f.description, f.value_type
         FROM role_fields rf
         JOIN roles ro ON ro.id = rf.role_id
         JOIN fields f ON f.id = rf.field_id
        WHERE ro.code = $1 ORDER BY rf.direction, rf.position, f.key`,
      [roleCode],
    );
    const inputs = [];
    const outputs = [];
    for (const row of r.rows) {
      const item = { ...mapField(row), required: row.required !== false };
      (row.direction === 'in' ? inputs : outputs).push(item);
    }
    return { roleCode, inputs, outputs };
  });
}

// Преобразовать ref (key или uuid) в field_id. Бросает 422, если поля нет.
async function resolveFieldId(c, ref) {
  const r = await c.query('SELECT id FROM fields WHERE id::text = $1 OR key = $1 LIMIT 1', [String(ref)]);
  if (!r.rowCount) throw httpError(422, 'field_unknown', { ref });
  return r.rows[0].id;
}

/**
 * Заменить контракт роли целиком (replace-set). Если контракт реально изменился
 * и роль задействована во ВКЛЮЧЁННЫХ этапах проектов — такие проекты ставятся на
 * паузу (пересогласование). Возвращает { ...contract, pausedProjects:[code] }.
 */
export async function saveRoleFields(s, code, input) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required');
  const normalized = normalizeContractInput(input);
  return withClient(clientConfig(s), async (c) => {
    const roleId = await roleIdByCode(c, roleCode);

    // Резолвим ссылки на поля до транзакции (понятная 422 вместо FK-ошибки).
    const resolve = async (items, direction) => {
      const out = [];
      for (let i = 0; i < items.length; i += 1) {
        out.push({ fieldId: await resolveFieldId(c, items[i].ref), required: items[i].required, position: i, direction });
      }
      return out;
    };
    const rows = [
      ...(await resolve(normalized.inputs, 'in')),
      ...(await resolve(normalized.outputs, 'out')),
    ];

    // Слепок «до» для определения реального изменения.
    const before = await c.query(
      'SELECT field_id, direction, required FROM role_fields WHERE role_id = $1 ORDER BY direction, position',
      [roleId],
    );

    const { changed, pausedProjects } = await withTransaction(c, async () => {
      await c.query('DELETE FROM role_fields WHERE role_id = $1', [roleId]);
      for (const row of rows) {
        await c.query(
          'INSERT INTO role_fields (role_id, field_id, direction, required, position) VALUES ($1, $2, $3, $4, $5)',
          [roleId, row.fieldId, row.direction, row.required, row.position],
        );
      }

      const changed = contractChanged(before.rows, rows);
      let pausedProjects = [];
      if (changed) {
        // Проекты, где роль есть во ВКЛЮЧЁННОМ этапе и проект ещё не на паузе.
        const paused = await c.query(
          `UPDATE projects p
              SET status = 'paused',
                  pause_reason = $2,
                  updated_at = now()
            WHERE p.status <> 'paused'
              AND EXISTS (
                SELECT 1 FROM project_stages ps
                  JOIN project_stage_roles psr ON psr.stage_id = ps.id
                 WHERE ps.project_id = p.id AND ps.enabled = true AND psr.role_id = $1
              )
            RETURNING p.code`,
          [roleId, `Изменён контракт полей роли ${roleCode} — требуется пересогласование этапов.`],
        );
        pausedProjects = paused.rows.map((x) => x.code);
      }
      return { changed, pausedProjects };
    });
    const contract = await getRoleFields(s, roleCode);
    return { ...contract, changed, pausedProjects };
  });
}

// Изменился ли контракт (множество (field_id,direction,required)).
function contractChanged(beforeRows, afterRows) {
  const norm = (rows) =>
    new Set(rows.map((r) => `${r.direction}:${r.field_id ?? r.fieldId}:${r.required !== false}`));
  const a = norm(beforeRows);
  const b = norm(afterRows);
  if (a.size !== b.size) return true;
  for (const x of a) if (!b.has(x)) return true;
  return false;
}
