// DEVELOPMENT-SCHEME-001 — единая «Схема разработки» для всех проектов.
//
// Этапы пайплайна (порядок ролей, по которому движется задача) — это ОДИН общий
// конвейер, а не настройка каждого проекта. Схема хранится в global_stages/
// global_stage_roles и МАТЕРИАЛИЗУЕТСЯ в project_stages каждого проекта при его
// создании и при сохранении схемы. Благодаря этому весь runner-код (db.js),
// читающий project_stages по project_id, остаётся без изменений: у всех проектов
// этапы одинаковы, отличается лишь подставляемая папка Scanner.
//
// Папка Scanner у каждого проекта своя — берётся из projects.docs_path («карта»
// проекта). В самой схеме watch_directory не хранится.
import { withClient, clientConfig } from './db.js';
import {
  normalizeStagesInput,
  saveStagesRows,
  isScannerStage,
  normalizeTaskStatus,
} from './stages.js';

// Глобальные роли пайплайна (единый источник истины для редактора схемы).
async function loadGlobalRoles(c) {
  const r = await c.query('SELECT id, code, name FROM roles ORDER BY code');
  return r.rows.map((row) => ({ id: row.id, code: row.code, name: row.name }));
}

// Прочитать этапы единой схемы как нормализованные записи (для материализации и
// для контракта API). Возвращает [{ id, position, name, enabled, taskStatus,
// roleIds, roleCodes }] в порядке position.
async function readGlobalStageRows(c) {
  const stages = await c.query(
    `SELECT id, position, name, enabled, task_status::text AS task_status,
            kind, stage_key, join_key
       FROM global_stages ORDER BY position`,
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT gsr.stage_id, gsr.role_id, gsr.position, r.code AS role_code
       FROM global_stage_roles gsr
       JOIN roles r ON r.id = gsr.role_id
      WHERE gsr.stage_id = ANY($1::uuid[])
      ORDER BY gsr.position, r.code`,
    [stages.rows.map((s) => s.id)],
  );
  const byStage = new Map();
  for (const row of roles.rows) {
    if (!byStage.has(row.stage_id)) byStage.set(row.stage_id, []);
    byStage.get(row.stage_id).push({ roleId: row.role_id, roleCode: row.role_code });
  }
  return stages.rows.map((row) => {
    const assigned = byStage.get(row.id) ?? [];
    return {
      id: row.id,
      position: row.position,
      name: row.name,
      enabled: row.enabled,
      // FORK-JOIN-001: тип узла + стабильный ключ + пара fork→join.
      kind: row.kind ?? 'stage',
      stageKey: row.stage_key ?? null,
      joinKey: row.join_key ?? null,
      taskStatus: normalizeTaskStatus(row.task_status),
      roleIds: assigned.map((a) => a.roleId),
      roleCodes: assigned.map((a) => a.roleCode),
    };
  });
}

// Рёбра графа единой схемы (слой авторинга) в порядке (from_key, position).
async function readGlobalEdges(c) {
  const r = await c.query(
    `SELECT from_key, to_key, condition, position
       FROM global_stage_edges ORDER BY from_key, position`,
  );
  return r.rows.map((row) => ({
    fromKey: row.from_key,
    toKey: row.to_key,
    condition: row.condition ?? null,
    position: row.position,
  }));
}

// Контракт ответа схемы: этапы (в форме, совместимой с RichStage фронтенда) +
// глобальные роли. scanner-блок отсутствует — папка Scanner задаётся в проекте.
function stageContract(row) {
  return {
    id: row.id,
    kind: row.kind ?? 'stage',
    stageKey: row.stageKey ?? null,
    joinKey: row.joinKey ?? null,
    name: row.name,
    enabled: row.enabled,
    position: row.position,
    taskStatus: row.taskStatus,
    roleIds: row.roleIds,
    roleCodes: row.roleCodes,
  };
}

export async function readScheme(c) {
  const rows = await readGlobalStageRows(c);
  const roles = await loadGlobalRoles(c);
  const edges = await readGlobalEdges(c);
  return { stages: rows.map(stageContract), roles, edges };
}

// Полная замена набора этапов единой схемы (в рамках открытой транзакции).
// Возвращает Set валидных stage_key (для проверки ссылок рёбер).
async function saveGlobalStages(c, normalized) {
  await c.query('DELETE FROM global_stages');
  const keys = new Set();
  for (const stage of normalized) {
    const ins = await c.query(
      `INSERT INTO global_stages (position, name, enabled, task_status, kind, stage_key, join_key)
       VALUES ($1, $2, $3, $4::task_status, $5, COALESCE($6::uuid, gen_random_uuid()), $7::uuid)
       RETURNING id, stage_key`,
      [stage.position, stage.name, stage.enabled, stage.taskStatus,
       stage.kind ?? 'stage', stage.stageKey, stage.joinKey ?? null],
    );
    const stageId = ins.rows[0].id;
    keys.add(ins.rows[0].stage_key);
    let pos = 0;
    for (const roleId of stage.roleIds) {
      await c.query(
        `INSERT INTO global_stage_roles (stage_id, role_id, position) VALUES ($1, $2, $3)
         ON CONFLICT (stage_id, role_id) DO NOTHING`,
        [stageId, roleId, pos++],
      );
    }
  }
  return keys;
}

/**
 * Нормализовать и провалидировать рёбра графа. Отбрасывает рёбра, чьи концы не
 * ссылаются на существующий stage_key (validKeys) или с пустыми ключами. Без
 * самопетель. Возвращает массив { fromKey, toKey, condition, position }.
 */
export function normalizeEdges(rawEdges, validKeys) {
  const list = Array.isArray(rawEdges) ? rawEdges : [];
  const keys = validKeys instanceof Set ? validKeys : new Set(validKeys ?? []);
  const out = [];
  const seen = new Set();
  let pos = 0;
  for (const e of list) {
    const fromKey = String(e?.fromKey ?? '').trim();
    const toKey = String(e?.toKey ?? '').trim();
    if (!fromKey || !toKey || fromKey === toKey) continue;
    if (!keys.has(fromKey) || !keys.has(toKey)) continue;
    const condition = e?.condition != null && String(e.condition).trim()
      ? String(e.condition).trim()
      : null;
    const dedupe = `${fromKey}->${toKey}:${condition ?? ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ fromKey, toKey, condition, position: pos++ });
  }
  return out;
}

// Полная замена рёбер глобальной схемы (в открытой транзакции).
async function saveGlobalEdges(c, edges) {
  await c.query('DELETE FROM global_stage_edges');
  for (const e of edges) {
    await c.query(
      `INSERT INTO global_stage_edges (from_key, to_key, condition, position)
       VALUES ($1::uuid, $2::uuid, $3, $4)`,
      [e.fromKey, e.toKey, e.condition, e.position],
    );
  }
}

// Материализовать рёбра глобальной схемы в project_stage_edges одного проекта.
// Ключи (stage_key) переносятся из global в project_stages один-в-один, поэтому
// рёбра проекта — копия глобальных + project_id (без позиционного маппинга).
export async function applyEdgesToProject(c, projectDbId) {
  await c.query('DELETE FROM project_stage_edges WHERE project_id = $1', [projectDbId]);
  await c.query(
    `INSERT INTO project_stage_edges (project_id, from_key, to_key, condition, position)
     SELECT $1, from_key, to_key, condition, position FROM global_stage_edges`,
    [projectDbId],
  );
}

/**
 * Материализовать единую схему в project_stages одного проекта. Scanner-этапу
 * подставляется папка проекта (docsPath). id этапов всегда новые (project_stages.id
 * — PK, не может совпадать у разных проектов). Вызывается в рамках открытой
 * транзакции (создание/обновление проекта, сохранение схемы).
 */
export async function applySchemeToProject(c, projectDbId, docsPath) {
  const scheme = await readGlobalStageRows(c);
  const docs = docsPath ? String(docsPath).trim() || null : null;
  // FORK-JOIN-001: gate-роли узлов fork/join инжектируются при материализации,
  // чтобы задача могла «сесть» на узел (current_role_id), а подметатель её нашёл.
  const gateRoles = await c.query(
    `SELECT id, code FROM roles WHERE code IN ('FORK_GATE','JOIN_GATE')`,
  );
  const gateIdByCode = new Map(gateRoles.rows.map((r) => [r.code, r.id]));
  const gateForKind = (kind) =>
    kind === 'fork' ? 'FORK_GATE' : kind === 'join' ? 'JOIN_GATE' : null;
  const rows = scheme.map((s) => {
    const gateCode = gateForKind(s.kind);
    const gateId = gateCode ? gateIdByCode.get(gateCode) : null;
    return {
      id: null,
      // FORK-JOIN-001: переносим тип и СТАБИЛЬНЫЙ ключ узла из глобальной схемы,
      // чтобы рёбра проекта (копия глобальных по ключам) сошлись по концам.
      kind: s.kind ?? 'stage',
      stageKey: s.stageKey ?? null,
      joinKey: s.joinKey ?? null,
      name: s.name,
      enabled: s.enabled,
      position: s.position,
      // Папку отслеживания получает только Scanner-этап — из docs_path проекта.
      watchDirectory: isScannerStage(s) ? docs : null,
      taskStatus: s.taskStatus,
      // Управляющему узлу — gate-роль; обычному этапу — его роли из схемы.
      roleIds: gateId ? [gateId] : s.roleIds,
      roleCodes: gateCode ? [gateCode] : s.roleCodes,
    };
  });
  await saveStagesRows(c, projectDbId, rows);
  await applyEdgesToProject(c, projectDbId);
}

// Переприменить схему ко всем проектам (после сохранения схемы). У каждого
// проекта своя docs_path → своя папка Scanner.
export async function applySchemeToAllProjects(c) {
  const projects = await c.query('SELECT id, docs_path FROM projects');
  for (const p of projects.rows) {
    await applySchemeToProject(c, p.id, p.docs_path);
  }
}

/** GET /api/development-scheme — единая схема (этапы + глобальные роли). */
export async function getScheme(s) {
  return withClient(clientConfig(s), async (c) => readScheme(c));
}

/**
 * PUT /api/development-scheme — сохранить единую схему и переприменить её ко всем
 * проектам. Валидация этапов (как у проекта), но без обязательной папки Scanner —
 * она задаётся в каждом проекте (docs_path). 422 при ошибке валидации/контрактов.
 */
export async function saveScheme(s, input) {
  const rawStages = Array.isArray(input?.stages) ? input.stages : [];
  const rawEdges = Array.isArray(input?.edges) ? input.edges : [];
  return withClient(clientConfig(s), async (c) => {
    const normalized = await normalizeStagesInput(c, rawStages, { requireScannerWatch: false });
    await c.query('BEGIN');
    try {
      const validKeys = await saveGlobalStages(c, normalized);
      // Рёбра валидируются ПОСЛЕ записи этапов: их концы должны ссылаться на
      // существующие stage_key (несуществующие/самопетли отбрасываются).
      await saveGlobalEdges(c, normalizeEdges(rawEdges, validKeys));
      await applySchemeToAllProjects(c);
      const scheme = await readScheme(c);
      await c.query('COMMIT');
      return scheme;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}
