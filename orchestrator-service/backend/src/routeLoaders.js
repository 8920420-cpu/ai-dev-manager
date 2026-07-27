// Загрузка маршрута/графа проекта и контрактов ролей из БД: плоский маршрут этапов
// (buildRoute), узлы/рёбра графа, граф-переход по вердикту и контракт полей роли
// (role_fields). Чистый leaf: зависит только от projectRoute.js и graphRoute.js.
import { buildRoute, resolveTransition } from './projectRoute.js';
import { buildGraph, nextNodeKey, nodeByKey, reworkNodeKey } from './graphRoute.js';

// --- Динамический маршрут проекта (PIPELINE-DYNAMIC-ROUTE-001) ---------------

// Прочитать этапы проекта и собрать плоский маршрут (buildRoute). Пустой массив
// — у проекта нет этапов (применяется канонический фолбэк ROLE_FLOW).
export async function loadProjectRoute(c, projectId) {
  if (!projectId) return [];
  const stages = await c.query(
    `SELECT id, position, enabled, task_status::text AS task_status, stage_key
       FROM project_stages WHERE project_id = $1 ORDER BY position`,
    [projectId],
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT psr.stage_id, r.code, psr.position
       FROM project_stage_roles psr JOIN roles r ON r.id = psr.role_id
      WHERE psr.stage_id = ANY($1::uuid[]) ORDER BY psr.position, r.code`,
    [stages.rows.map((s) => s.id)],
  );
  const byStage = new Map();
  for (const row of roles.rows) {
    if (!byStage.has(row.stage_id)) byStage.set(row.stage_id, []);
    byStage.get(row.stage_id).push(row.code);
  }
  return buildRoute(
    stages.rows.map((s) => ({
      position: s.position,
      enabled: s.enabled,
      taskStatus: s.task_status,
      stageKey: s.stage_key,
      roleCodes: byStage.get(s.id) ?? [],
    })),
  );
}

// FORK-JOIN-001: узлы проекта по стабильному ключу (для граф-маршрутизации и
// подметателей fork/join). Первая роль этапа — исполнитель/gate узла.
async function loadProjectNodes(c, projectId) {
  const stages = await c.query(
    `SELECT id, stage_key, kind, join_key, name, enabled, task_status::text AS task_status
       FROM project_stages WHERE project_id = $1 ORDER BY position`,
    [projectId],
  );
  if (!stages.rowCount) return [];
  const roles = await c.query(
    `SELECT psr.stage_id, psr.role_id, r.code, psr.position
       FROM project_stage_roles psr JOIN roles r ON r.id = psr.role_id
      WHERE psr.stage_id = ANY($1::uuid[]) ORDER BY psr.position, r.code`,
    [stages.rows.map((s) => s.id)],
  );
  const firstRole = new Map();
  for (const row of roles.rows) {
    if (!firstRole.has(row.stage_id)) firstRole.set(row.stage_id, { roleId: row.role_id, roleCode: row.code });
  }
  return stages.rows.map((s) => ({
    stageKey: s.stage_key,
    kind: s.kind ?? 'stage',
    joinKey: s.join_key ?? null,
    name: s.name,
    enabled: s.enabled,
    status: s.task_status,
    roleId: firstRole.get(s.id)?.roleId ?? null,
    roleCode: firstRole.get(s.id)?.roleCode ?? null,
  }));
}

// Загрузить рёбра графа проекта (для граф-маршрутизации). [] — линейный проект.
async function loadProjectEdges(c, projectId) {
  const r = await c.query(
    `SELECT from_key, to_key, condition, position
       FROM project_stage_edges WHERE project_id = $1 ORDER BY from_key, position`,
    [projectId],
  );
  return r.rows.map((e) => ({
    fromKey: e.from_key, toKey: e.to_key, condition: e.condition ?? null, position: e.position,
  }));
}

// Построить граф проекта (узлы + рёбра) для graphRoute. null — нет рёбер (линейный).
export async function loadProjectGraph(c, projectId) {
  const edges = await loadProjectEdges(c, projectId);
  if (!edges.length) return null;
  const nodes = await loadProjectNodes(c, projectId);
  return { graph: buildGraph(nodes, edges), nodes };
}

/**
 * FORK-JOIN-001: граф-переход для задачи с current_stage_key. Возвращает контракт
 * как resolveTransition, плюс nextStageKey. Узлы fork/join несут gate-роль —
 * задача «садится» на них, а дальше её обрабатывает подметатель.
 */
export async function resolveGraphTransition(c, claimed, decision) {
  if (decision.outcome === 'BLOCK') {
    return { nextRole: null, toStatus: decision.blockStatus || 'BLOCKED', done: false, blocked: true, via: 'graph', nextStageKey: claimed.current_stage_key };
  }
  const loaded = await loadProjectGraph(c, claimed.project_id);
  if (!loaded) {
    // Рёбра исчезли (схему переписали в линейную) — фолбэк на позиционный резолвер.
    const route = await loadProjectRoute(c, claimed.project_id);
    return { ...resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    }), nextStageKey: null };
  }
  // FA-REWORK-ROUTE-001: доработка (напр. диагност сбоя вернул задачу) идёт НАЗАД к
  // ближайшему исполнителю по рёбрам графа, а не вперёд по маршруту — иначе вердикт
  // «на доработку» проглатывается следующим узлом (fork/join спавнит ветки как при
  // успехе). Цели нет (нет исполнителя выше по графу) → фолбэк на линейный резолвер.
  if (decision.outcome === 'REWORK') {
    const backKey = reworkNodeKey(loaded.graph, claimed.current_stage_key);
    if (backKey) {
      const backNode = nodeByKey(loaded.graph, backKey);
      return {
        nextRole: backNode?.roleCode ?? null,
        toStatus: backNode?.status || claimed.status,
        done: false, blocked: false, via: 'graph', nextStageKey: backKey,
      };
    }
    const route = await loadProjectRoute(c, claimed.project_id);
    return { ...resolveTransition(route, claimed.role_code, decision, {
      currentStatus: claimed.status,
      currentStageKey: claimed.current_stage_key,
    }), nextStageKey: null };
  }
  const nextKey = nextNodeKey(loaded.graph, claimed.current_stage_key, decision);
  if (!nextKey) {
    return { nextRole: null, toStatus: 'DONE', done: true, blocked: false, via: 'graph', nextStageKey: null };
  }
  const node = nodeByKey(loaded.graph, nextKey);
  return {
    nextRole: node?.roleCode ?? null,
    // gate-узлы (fork/join) не имеют статуса — сохраняем текущий статус задачи.
    toStatus: node?.status || claimed.status,
    done: false,
    blocked: false,
    via: 'graph',
    nextStageKey: nextKey,
  };
}

// Кэш наличия таблицы role_fields (контракт необязателен — может не быть миграции).
let _roleFieldsTablePresent;
async function roleFieldsTablePresent(c) {
  if (_roleFieldsTablePresent === undefined) {
    const reg = await c.query("SELECT to_regclass('public.role_fields') AS t");
    _roleFieldsTablePresent = Boolean(reg.rows[0]?.t);
  }
  return _roleFieldsTablePresent;
}

// Только для тестов: сбросить кэш наличия role_fields (он глобален на процесс,
// поэтому fake-клиенты разных тест-файлов могут зафиксировать чужое значение).
export function __resetRoleFieldsCacheForTests() {
  _roleFieldsTablePresent = undefined;
}

// Контракт одной роли: { inputs:[{key,required}], outputs:[{key,required}] }.
export async function loadRoleContract(c, roleCode) {
  const empty = { inputs: [], outputs: [] };
  if (!(await roleFieldsTablePresent(c))) return empty;
  const r = await c.query(
    `SELECT rf.direction, rf.required, f.key, f.name, f.description, f.value_type
       FROM role_fields rf
       JOIN roles ro ON ro.id = rf.role_id
       JOIN fields f ON f.id = rf.field_id
      WHERE ro.code = $1 ORDER BY rf.position, f.key`,
    [roleCode],
  );
  const out = { inputs: [], outputs: [] };
  for (const row of r.rows) {
    (row.direction === 'in' ? out.inputs : out.outputs).push({
      key: row.key,
      required: row.required !== false,
      name: row.name ?? row.key,
      description: row.description ?? '',
      valueType: row.value_type ?? 'text',
    });
  }
  return out;
}
