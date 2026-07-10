// MCP-ROLES-001 — API раздела «MCP роли».
//
// MCP-роль — обычная строка таблицы roles с флагом is_mcp_role=true. Раздел даёт
// полный CRUD ТОЛЬКО над MCP-ролями (пайплайновые роли сюда не попадают и не
// затрагиваются). У роли хранится:
//   * prompt        — промт роли (общая колонка roles.prompt);
//   * requirements  — требования к роли (свободный текст, колонка roles.requirements).
//
// Эндпоинты (см. docs/api-mcp-roles.md):
//   GET    /api/mcp-roles          — список MCP-ролей
//   POST   /api/mcp-roles          — создать MCP-роль
//   GET    /api/mcp-roles/:code    — карточка MCP-роли
//   PUT    /api/mcp-roles/:code    — частичное обновление карточки
//   DELETE /api/mcp-roles/:code    — удалить MCP-роль
//
// Идентичность роли — её `code` (уникальный, неизменяемый после создания).
import { withClient, clientConfig } from './db.js';

import { httpCodedError as httpError } from './httpError.js';

// Лимиты полей карточки MCP-роли (защита от раздувания и мусора).
export const MCP_ROLE_LIMITS = {
  code: 64,
  name: 200,
  description: 2000,
  prompt: 100000,
  requirements: 20000,
};

// Код роли: латиница/цифры/._- начиная с буквы. Тот же класс, что у ключей полей.
const CODE_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

// --- Чистые функции (без БД) — покрыты юнит-тестами -------------------------

/** Нормализовать текстовое поле карточки: trim, обрезка пустого до null, лимит. */
function normalizeText(value, limit, errorCode) {
  if (value == null) return null;
  const text = String(value);
  if (text.length > limit) throw httpError(422, errorCode);
  const trimmed = text.trim();
  return trimmed === '' ? null : text;
}

/**
 * ЧИСТАЯ валидация + нормализация тела СОЗДАНИЯ MCP-роли.
 * Требуется code и name; description/prompt/requirements — опциональны.
 * Возвращает { code, name, description, prompt, requirements }. Бросает httpError(422).
 */
export function normalizeMcpRoleCreate(input) {
  if (input == null || typeof input !== 'object') throw httpError(422, 'mcp_role_invalid_body');

  const code = String(input.code ?? '').trim();
  if (!code) throw httpError(422, 'mcp_role_code_required');
  if (!CODE_RE.test(code)) throw httpError(422, 'mcp_role_code_invalid', { code });

  const name = String(input.name ?? '').trim();
  if (!name) throw httpError(422, 'mcp_role_name_required');
  if (name.length > MCP_ROLE_LIMITS.name) throw httpError(422, 'mcp_role_name_too_long');

  return {
    code,
    name,
    description: normalizeText(input.description, MCP_ROLE_LIMITS.description, 'mcp_role_description_too_long'),
    prompt: normalizeText(input.prompt, MCP_ROLE_LIMITS.prompt, 'mcp_role_prompt_too_long'),
    requirements: normalizeText(input.requirements, MCP_ROLE_LIMITS.requirements, 'mcp_role_requirements_too_long'),
  };
}

/**
 * ЧИСТАЯ валидация + нормализация тела ОБНОВЛЕНИЯ MCP-роли (частичное).
 * code роли не меняется. Возвращает patch только с переданными полями.
 */
export function normalizeMcpRoleUpdate(input) {
  if (input == null || typeof input !== 'object') throw httpError(422, 'mcp_role_invalid_body');
  const patch = {};

  if ('name' in input) {
    const name = String(input.name ?? '').trim();
    if (!name) throw httpError(422, 'mcp_role_name_required');
    if (name.length > MCP_ROLE_LIMITS.name) throw httpError(422, 'mcp_role_name_too_long');
    patch.name = name;
  }
  if ('description' in input) {
    patch.description = normalizeText(input.description, MCP_ROLE_LIMITS.description, 'mcp_role_description_too_long');
  }
  if ('prompt' in input) {
    patch.prompt = normalizeText(input.prompt, MCP_ROLE_LIMITS.prompt, 'mcp_role_prompt_too_long');
  }
  if ('requirements' in input) {
    patch.requirements = normalizeText(input.requirements, MCP_ROLE_LIMITS.requirements, 'mcp_role_requirements_too_long');
  }
  return patch;
}

/** DTO карточки MCP-роли. */
export function mapMcpRole(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description ?? '',
    prompt: row.prompt ?? '',
    requirements: row.requirements ?? '',
    isMcpRole: row.is_mcp_role === true,
  };
}

const SELECT_COLS = 'code, name, description, prompt, requirements, is_mcp_role';

// --- CRUD -------------------------------------------------------------------

/** GET /api/mcp-roles — список MCP-ролей (is_mcp_role=true). */
export async function listMcpRoles(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT ${SELECT_COLS} FROM roles WHERE is_mcp_role = true ORDER BY sort_order, code`,
    );
    return { roles: r.rows.map(mapMcpRole) };
  });
}

/** GET /api/mcp-roles/:code — карточка одной MCP-роли (404, если её нет). */
export async function getMcpRole(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'mcp_role_code_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      `SELECT ${SELECT_COLS} FROM roles WHERE code = $1 AND is_mcp_role = true`,
      [roleCode],
    );
    if (!r.rowCount) throw httpError(404, 'mcp_role_not_found');
    return mapMcpRole(r.rows[0]);
  });
}

/**
 * POST /api/mcp-roles — создать MCP-роль. Всегда is_mcp_role=true. Код уникален:
 * коллизия с любой ролью (в т.ч. пайплайновой) → 409 mcp_role_code_exists.
 */
export async function createMcpRole(s, input) {
  const data = normalizeMcpRoleCreate(input);
  return withClient(clientConfig(s), async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO roles (code, name, description, prompt, requirements, is_mcp_role)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING ${SELECT_COLS}`,
        [data.code, data.name, data.description, data.prompt, data.requirements],
      );
      return mapMcpRole(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'mcp_role_code_exists', { code: data.code });
      throw e;
    }
  });
}

/**
 * PUT /api/mcp-roles/:code — частичное обновление карточки MCP-роли. Меняет только
 * переданные поля (name/description/prompt/requirements). Ограничено is_mcp_role=true,
 * чтобы через этот раздел нельзя было редактировать пайплайновую роль.
 */
export async function updateMcpRole(s, code, input) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'mcp_role_code_required');
  const patch = normalizeMcpRoleUpdate(input);
  const keys = Object.keys(patch);

  return withClient(clientConfig(s), async (c) => {
    if (!keys.length) {
      const r = await c.query(
        `SELECT ${SELECT_COLS} FROM roles WHERE code = $1 AND is_mcp_role = true`,
        [roleCode],
      );
      if (!r.rowCount) throw httpError(404, 'mcp_role_not_found');
      return mapMcpRole(r.rows[0]);
    }
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const r = await c.query(
      `UPDATE roles SET ${sets.join(', ')}
        WHERE code = $1 AND is_mcp_role = true
        RETURNING ${SELECT_COLS}`,
      [roleCode, ...keys.map((k) => patch[k])],
    );
    if (!r.rowCount) throw httpError(404, 'mcp_role_not_found');
    return mapMcpRole(r.rows[0]);
  });
}

/**
 * DELETE /api/mcp-roles/:code — удалить MCP-роль. Ограничено is_mcp_role=true:
 * пайплайновую роль этим маршрутом удалить нельзя (404).
 */
export async function deleteMcpRole(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'mcp_role_code_required');
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(
      'DELETE FROM roles WHERE code = $1 AND is_mcp_role = true RETURNING code',
      [roleCode],
    );
    if (!r.rowCount) throw httpError(404, 'mcp_role_not_found');
    return { deleted: true };
  });
}
