// INFRA-DEPARTMENT-001 — построение ИЗОЛИРОВАННОГО инфра-конвейера (граф
// project_stages + project_stage_edges) для проекта Инфраструктурного отдела.
//
// В отличие от единой «Схемы разработки» (developmentScheme.js), которая
// материализуется во ВСЕ проекты, инфра-конвейер строится только для проектов с
// pipeline_kind='infrastructure' и НЕ затрагивается сохранением дев-схемы (та
// защищена guard'ом в applySchemeToProject по pipeline_kind). Дев-конвейер и
// инфра-конвейер полностью независимы; общий у них только рантайм-резолвер
// (projectRoute/graphRoute), который читает project_stages по project_id.
//
// Граф (fork/join даёт параллелизм семи доменных исполнителей):
//   Инфраструктурный архитектор (ARCHITECTURE)
//     → FORK → [7 исполнителей (CODING) параллельно] → JOIN
//     → Специалист по ИБ (REVIEW) → SRE-инженер (REVIEW)
//     → Специалист по мониторингу (TESTING) → Git Integrator (COMMIT) → DONE.
//
// Гейты ИБ/SRE/мониторинга при провале возвращают задачу ближайшему исполнителю
// (reworkTarget по обратным рёбрам графа, см. decideOutcome + graphRoute).
import { randomUUID } from 'node:crypto';
import { saveStagesRows } from './stages.js';

// Семь доменных исполнителей (параллельные ветки fork) с подписями этапов.
export const INFRA_EXECUTORS = [
  { code: 'SYSADMIN',                name: 'Системный администратор' },
  { code: 'DEVOPS_ENGINEER',         name: 'DevOps-инженер' },
  { code: 'NETWORK_ENGINEER',        name: 'Сетевой инженер' },
  { code: 'K8S_ENGINEER',            name: 'Инженер Kubernetes' },
  { code: 'DOCKER_ENGINEER',         name: 'Инженер Docker' },
  { code: 'VIRTUALIZATION_ENGINEER', name: 'Специалист по виртуализации' },
  { code: 'BACKUP_ENGINEER',         name: 'Специалист по резервному копированию' },
];

// Все коды ролей графа (доменные роли + управляющие узлы fork/join) — их id нужны
// для project_stage_roles. Резолвятся одним запросом.
const GRAPH_ROLE_CODES = [
  'INFRA_ARCHITECT',
  ...INFRA_EXECUTORS.map((e) => e.code),
  'SECURITY_ENGINEER', 'SRE_ENGINEER', 'MONITORING_ENGINEER', 'GIT_INTEGRATOR',
  'FORK_GATE', 'JOIN_GATE',
];

// Роль code → id. Бросает, если какой-то роли нет (нужна миграция 0058).
async function loadRoleIds(c) {
  const r = await c.query('SELECT id, code FROM roles WHERE code = ANY($1::text[])', [GRAPH_ROLE_CODES]);
  const byCode = new Map(r.rows.map((row) => [row.code, row.id]));
  const missing = GRAPH_ROLE_CODES.filter((code) => !byCode.has(code));
  if (missing.length) {
    throw new Error(`INFRA scheme: в БД нет ролей ${missing.join(', ')} — накатите миграцию 0058_infrastructure_department.sql`);
  }
  return byCode;
}

// Существующие stage_key проекта по коду роли узла (для стабильности ключей при
// повторной материализации: in-flight задачи ссылаются на current_stage_key — не
// пересоздаём ключи без нужды). Управляющие узлы ключуются по FORK_GATE/JOIN_GATE.
async function existingKeysByRole(c, projectDbId) {
  const r = await c.query(
    `SELECT ps.stage_key, r.code
       FROM project_stages ps
       JOIN project_stage_roles psr ON psr.stage_id = ps.id
       JOIN roles r ON r.id = psr.role_id
      WHERE ps.project_id = $1`,
    [projectDbId],
  );
  const byCode = new Map();
  for (const row of r.rows) if (!byCode.has(row.code)) byCode.set(row.code, row.stage_key);
  return byCode;
}

/**
 * Построить нормализованные этапы + рёбра инфра-графа. keyForCode(code) отдаёт
 * СТАБИЛЬНЫЙ stage_key узла роли (существующий или новый), чтобы повторный вызов
 * не менял ключи. Чистая функция (без БД) — удобна для юнит-тестов формы графа.
 */
export function buildInfraGraph(roleIdByCode, keyForCode = () => randomUUID()) {
  const archKey = keyForCode('INFRA_ARCHITECT');
  const forkKey = keyForCode('FORK_GATE');
  const joinKey = keyForCode('JOIN_GATE');
  const execKeys = INFRA_EXECUTORS.map((e) => keyForCode(e.code));
  const secKey = keyForCode('SECURITY_ENGINEER');
  const sreKey = keyForCode('SRE_ENGINEER');
  const monKey = keyForCode('MONITORING_ENGINEER');
  const gitKey = keyForCode('GIT_INTEGRATOR');

  let position = 0;
  const stage = (stageKey, name, kind, taskStatus, roleCodes, extra = {}) => ({
    id: null,
    kind,
    stageKey,
    joinKey: extra.joinKey ?? null,
    name,
    enabled: true,
    position: position++,
    watchDirectory: null,
    taskStatus,
    roleIds: roleCodes.map((code) => roleIdByCode.get(code)),
    roleCodes,
  });

  const stages = [
    stage(archKey, 'Инфраструктурный архитектор', 'stage', 'ARCHITECTURE', ['INFRA_ARCHITECT']),
    // FORK-JOIN-001: fork ссылается на парный join через join_key — advanceForkNodes
    // паркует на нём родителя в WAITING_FOR_CHILDREN.
    stage(forkKey, 'Fork (домены параллельно)', 'fork', null, ['FORK_GATE'], { joinKey }),
    ...INFRA_EXECUTORS.map((e, i) => stage(execKeys[i], e.name, 'stage', 'CODING', [e.code])),
    stage(joinKey, 'Join (ветки сошлись)', 'join', null, ['JOIN_GATE']),
    stage(secKey, 'Специалист по ИБ', 'stage', 'REVIEW', ['SECURITY_ENGINEER']),
    stage(sreKey, 'SRE-инженер', 'stage', 'REVIEW', ['SRE_ENGINEER']),
    stage(monKey, 'Специалист по мониторингу', 'stage', 'TESTING', ['MONITORING_ENGINEER']),
    stage(gitKey, 'Git Integrator', 'stage', 'COMMIT', ['GIT_INTEGRATOR']),
  ];

  let edgePos = 0;
  const edge = (fromKey, toKey, condition = null) => ({ fromKey, toKey, condition, position: edgePos++ });
  const edges = [
    edge(archKey, forkKey),
    ...execKeys.map((k) => edge(forkKey, k)), // fork → каждый исполнитель (ветки)
    ...execKeys.map((k) => edge(k, joinKey)), // каждый исполнитель → join
    edge(joinKey, secKey),
    edge(secKey, sreKey),
    edge(sreKey, monKey),
    edge(monKey, gitKey),
  ];
  return { stages, edges };
}

/**
 * Материализовать инфра-граф в project_stages + project_stage_edges проекта (в
 * рамках уже открытой транзакции). Ключи узлов стабильны между вызовами. Вызывается
 * из applyInfraSchemeToProject (обёртка с транзакцией) и из seed-скрипта.
 */
export async function saveInfraSchemeRows(c, projectDbId) {
  const roleIdByCode = await loadRoleIds(c);
  const existing = await existingKeysByRole(c, projectDbId);
  const keyForCode = (code) => existing.get(code) ?? randomUUID();
  const { stages, edges } = buildInfraGraph(roleIdByCode, keyForCode);

  await saveStagesRows(c, projectDbId, stages);
  await c.query('DELETE FROM project_stage_edges WHERE project_id = $1', [projectDbId]);
  for (const e of edges) {
    await c.query(
      `INSERT INTO project_stage_edges (project_id, from_key, to_key, condition, position)
       VALUES ($1, $2::uuid, $3::uuid, $4, $5)`,
      [projectDbId, e.fromKey, e.toKey, e.condition, e.position],
    );
  }
  return { stages: stages.length, edges: edges.length };
}
