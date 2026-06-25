// TOOLS-REGISTRY-001 — реестр инструментов (Tools) и привязка к ролям.
//
// Tools — отдельная от skills сущность. builtin исполняет микросервис tools-service
// (function-calling рассуждающих ролей), mcp прокидывается Claude Code (PROGRAMMER).
import { withClient, clientConfig } from './db.js';

function httpError(statusCode, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (extra) Object.assign(error, extra);
  return error;
}

export const VALID_TOOL_KINDS = new Set(['builtin', 'mcp']);

// Уровни доступа (чекбоксы карточки роли). read — чтение/поиск; modify — правка
// существующих файлов; create — создание/перезапись; delete — удаление; execute —
// выполнение команд (резерв для MCP/Claude Code).
export const CAPABILITIES = ['read', 'modify', 'create', 'delete', 'execute'];
const CAPABILITY_SET = new Set(CAPABILITIES);

// JSON-схемы builtin-инструментов для function-calling (OpenAI-совместимый формат).
// Параметр root не отдаём модели — его подставляет оркестратор (корень проекта задачи).
export const BUILTIN_TOOL_SCHEMAS = {
  read_file: {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать файл реального проекта по относительному пути от корня проекта.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Относительный путь файла от корня проекта' } },
        required: ['path'],
      },
    },
  },
  list_dir: {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Список содержимого каталога реального проекта (файлы и папки).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Относительный путь каталога (по умолчанию корень)' } },
      },
    },
  },
  search_text: {
    type: 'function',
    function: {
      name: 'search_text',
      description: 'Подстрочный поиск по тексту файлов реального проекта (вернёт файл, строку, текст).',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Искомая подстрока' } },
        required: ['query'],
      },
    },
  },
  edit_file: {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Изменить существующий файл проекта: заменить точный фрагмент oldText на newText.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь файла' },
          oldText: { type: 'string', description: 'Точный существующий фрагмент для замены' },
          newText: { type: 'string', description: 'Новый текст вместо oldText' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
  write_file: {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создать или перезаписать файл проекта целиком указанным содержимым.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь файла' },
          content: { type: 'string', description: 'Полное содержимое файла' },
        },
        required: ['path', 'content'],
      },
    },
  },
  delete_file: {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Удалить файл проекта по относительному пути.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Относительный путь файла' } },
        required: ['path'],
      },
    },
  },
};

function mapTool(row) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    capability: row.capability ?? 'read',
    description: row.description ?? '',
    config: row.config ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

const TOOL_COLUMNS = 'id, name, kind, capability, description, config, created_at, updated_at';

// ЧИСТАЯ нормализация/валидация входа tool. partial=true для PUT.
export function normalizeToolInput(input, { partial = false } = {}) {
  const out = {};
  if (!partial || input?.name !== undefined) {
    const name = String(input?.name ?? '').trim();
    if (!name) throw httpError(422, 'tool_name_required', { code: 'tool_name_required' });
    out.name = name;
  }
  if (!partial || input?.kind !== undefined) {
    const kind = String(input?.kind ?? 'builtin').trim();
    if (!VALID_TOOL_KINDS.has(kind)) throw httpError(422, 'tool_kind_invalid', { code: 'tool_kind_invalid' });
    out.kind = kind;
  }
  if (!partial || input?.capability !== undefined) {
    const cap = String(input?.capability ?? 'read').trim();
    if (!CAPABILITY_SET.has(cap)) throw httpError(422, 'tool_capability_invalid', { code: 'tool_capability_invalid' });
    out.capability = cap;
  }
  if (!partial || input?.description !== undefined) {
    out.description = String(input?.description ?? '').trim();
  }
  if (!partial || input?.config !== undefined) {
    const cfg = input?.config;
    if (cfg != null && (typeof cfg !== 'object' || Array.isArray(cfg))) {
      throw httpError(422, 'tool_config_invalid', { code: 'tool_config_invalid' });
    }
    out.config = cfg ?? {};
  }
  return out;
}

export async function listTools(s) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(`SELECT ${TOOL_COLUMNS} FROM tools ORDER BY kind, name`);
    return { tools: r.rows.map(mapTool) };
  });
}

export async function getTool(s, id) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query(`SELECT ${TOOL_COLUMNS} FROM tools WHERE id = $1`, [id]);
    if (!r.rowCount) throw httpError(404, 'tool_not_found', { code: 'tool_not_found' });
    return mapTool(r.rows[0]);
  });
}

export async function createTool(s, input) {
  const fields = normalizeToolInput(input, { partial: false });
  return withClient(clientConfig(s), async (c) => {
    try {
      const r = await c.query(
        `INSERT INTO tools (name, kind, capability, description, config)
         VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING ${TOOL_COLUMNS}`,
        [fields.name, fields.kind, fields.capability ?? 'read', fields.description ?? '', JSON.stringify(fields.config ?? {})],
      );
      return mapTool(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'tool_name_exists', { code: 'tool_name_exists' });
      throw e;
    }
  });
}

export async function updateTool(s, id, patch) {
  const fields = normalizeToolInput(patch, { partial: true });
  const keys = Object.keys(fields);
  return withClient(clientConfig(s), async (c) => {
    if (!keys.length) {
      const r = await c.query(`SELECT ${TOOL_COLUMNS} FROM tools WHERE id = $1`, [id]);
      if (!r.rowCount) throw httpError(404, 'tool_not_found', { code: 'tool_not_found' });
      return mapTool(r.rows[0]);
    }
    const sets = keys.map((k, i) => (k === 'config' ? `config = $${i + 2}::jsonb` : `${k} = $${i + 2}`));
    const params = [id, ...keys.map((k) => (k === 'config' ? JSON.stringify(fields[k]) : fields[k]))];
    try {
      const r = await c.query(
        `UPDATE tools SET ${sets.join(', ')} WHERE id = $1 RETURNING ${TOOL_COLUMNS}`,
        params,
      );
      if (!r.rowCount) throw httpError(404, 'tool_not_found', { code: 'tool_not_found' });
      return mapTool(r.rows[0]);
    } catch (e) {
      if (e.code === '23505') throw httpError(409, 'tool_name_exists', { code: 'tool_name_exists' });
      throw e;
    }
  });
}

export async function deleteTool(s, id) {
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query('DELETE FROM tools WHERE id = $1', [id]);
    if (!r.rowCount) throw httpError(404, 'tool_not_found', { code: 'tool_not_found' });
    return { deleted: true };
  });
}

// --- Привязка инструментов к роли -------------------------------------------

async function readRoleToolRows(c, roleCode) {
  const r = await c.query(
    `SELECT t.${TOOL_COLUMNS.split(', ').join(', t.')}
       FROM role_tools rt JOIN tools t ON t.id = rt.tool_id
      WHERE rt.role_code = $1 ORDER BY rt.position, t.name`,
    [roleCode],
  );
  return r.rows.map(mapTool);
}

export async function getRoleTools(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required', { code: 'role_code_required' });
  return withClient(clientConfig(s), async (c) => {
    const tools = await readRoleToolRows(c, roleCode);
    return { roleCode, toolIds: tools.map((t) => t.id), tools };
  });
}

export async function saveRoleTools(s, code, input) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required', { code: 'role_code_required' });
  const rawIds = Array.isArray(input?.toolIds) ? input.toolIds : Array.isArray(input) ? input : [];
  const ids = [...new Set(rawIds.map((x) => String(x)).filter(Boolean))];
  return withClient(clientConfig(s), async (c) => {
    if (ids.length) {
      const check = await c.query('SELECT id FROM tools WHERE id = ANY($1::uuid[])', [ids]);
      const known = new Set(check.rows.map((r) => String(r.id)));
      for (const id of ids) {
        if (!known.has(id)) throw httpError(422, 'tool_unknown', { code: 'tool_unknown', toolId: id });
      }
    }
    await c.query('BEGIN');
    try {
      await c.query('DELETE FROM role_tools WHERE role_code = $1', [roleCode]);
      for (let i = 0; i < ids.length; i += 1) {
        await c.query(
          'INSERT INTO role_tools (role_code, tool_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [roleCode, ids[i], i],
        );
      }
      const tools = await readRoleToolRows(c, roleCode);
      await c.query('COMMIT');
      return { roleCode, toolIds: tools.map((t) => t.id), tools };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

// --- Уровни доступа роли (role_capabilities) --------------------------------

export async function getRoleCapabilities(s, code) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required', { code: 'role_code_required' });
  return withClient(clientConfig(s), async (c) => {
    const r = await c.query('SELECT capability FROM role_capabilities WHERE role_code = $1', [roleCode]);
    return { roleCode, capabilities: r.rows.map((x) => x.capability) };
  });
}

export async function saveRoleCapabilities(s, code, input) {
  const roleCode = String(code ?? '').trim();
  if (!roleCode) throw httpError(422, 'role_code_required', { code: 'role_code_required' });
  const raw = Array.isArray(input?.capabilities) ? input.capabilities : Array.isArray(input) ? input : [];
  const caps = [...new Set(raw.map((x) => String(x).trim()))];
  for (const cap of caps) {
    if (!CAPABILITY_SET.has(cap)) throw httpError(422, 'capability_invalid', { code: 'capability_invalid', capability: cap });
  }
  return withClient(clientConfig(s), async (c) => {
    await c.query('BEGIN');
    try {
      await c.query('DELETE FROM role_capabilities WHERE role_code = $1', [roleCode]);
      for (const cap of caps) {
        await c.query(
          'INSERT INTO role_capabilities (role_code, capability) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [roleCode, cap],
        );
      }
      await c.query('COMMIT');
      return { roleCode, capabilities: caps };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
}

/**
 * Инструменты роли для движка: { builtin:[name...], mcp:[{name,config}] }.
 * builtin — все builtin-инструменты, чей уровень доступа разрешён роли
 * (role_capabilities). mcp — явно привязанные MCP-серверы (role_tools).
 * Принимает уже открытый клиент (вызывается внутри обработки роли).
 */
export async function getToolsForRole(c, roleCode) {
  const caps = await c.query('SELECT capability FROM role_capabilities WHERE role_code = $1', [roleCode]);
  const allowed = new Set(caps.rows.map((x) => x.capability));
  const builtin = [];
  if (allowed.size) {
    const bt = await c.query(
      'SELECT name, capability FROM tools WHERE kind = $1 ORDER BY name',
      ['builtin'],
    );
    for (const row of bt.rows) {
      if (allowed.has(row.capability)) builtin.push(row.name);
    }
  }
  const mcpRows = await c.query(
    `SELECT t.name, t.config
       FROM role_tools rt JOIN tools t ON t.id = rt.tool_id
      WHERE rt.role_code = $1 AND t.kind = 'mcp' ORDER BY rt.position, t.name`,
    [roleCode],
  );
  const mcp = mcpRows.rows.map((row) => ({ name: row.name, config: row.config ?? {} }));
  return { builtin, mcp, capabilities: [...allowed] };
}
