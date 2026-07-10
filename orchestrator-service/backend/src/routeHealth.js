// ROUTE-HEALTH-001 — health-check маршрута проекта. Находит потенциальные ТУПИКИ
// маршрута ДО того, как на них зависнет задача:
//   1) роль в этапе без исполнителя (не reasoning, не host, не auto-переход);
//   2) обычный этап (kind=stage) с пустым task_status;
//   3) host-роль (PIPELINE_SERVICE/GIT_INTEGRATOR) с назначенным LLM-коннектором
//      — несоответствие типа роли и типа коннектора;
//   4) reasoning-роль без включённого коннектора/движка — исполнять некому;
//   5) непарные fork/join граф-узлы.
//
// FORK-JOIN-001: узлы kind=fork/join/condition — СИСТЕМНЫЕ graph-ноды. У них
// task_status пуст ШТАТНО (ими владеют подметатели advanceForkNodes/advanceJoinNodes),
// поэтому они ПОЛНОСТЬЮ исключены из проверок (1) и (2) и НЕ считаются «этапом без
// статуса». Для них — только отдельная проверка парности fork↔join.
//
// buildRouteHealthReport — чистая (без БД/сети), покрыта юнит-тестами.
// Источники истины — единственные, импортируются ниже.
import { withClient, clientConfig } from './db.js';
import { readStages, resolveProjectId, CONTROL_KINDS, normalizeKind } from './stages.js';
import { LLM_ROLE_CODES, HOST_ROLE_CODES } from './roleEngine.js';
import { AUTO_ROLE_CODES } from './rolePipeline.js';
import { asObject } from './dataCard.js';

// LLM/reasoning-провайдеры: назначение такого коннектора host-роли — ошибка типа.
export const LLM_CONNECTOR_PROVIDERS = new Set(['codex', 'claude_code', 'deepseek']);

const asArray = (v) => (Array.isArray(v) ? v : []);
const trimStr = (v) => String(v ?? '').trim();

/**
 * Построить структурированный отчёт о целостности маршрута проекта.
 *
 * @param stages            — контракты этапов (см. stages.js → stageContract):
 *                            { id, kind, stageKey, joinKey, name, enabled, position,
 *                              taskStatus, roleIds, roleCodes }.
 * @param connectorsByRole  — карта roleCode → { provider, isEnabled }.
 * @param deps              — переопределения источников истины (для тестов) +
 *                            deps.projectId для контракта ответа.
 * @returns { projectId, problems[], summary }.
 */
export function buildRouteHealthReport(stages, connectorsByRole = {}, deps = {}) {
  const llmRoles = new Set(deps.llmRoleCodes ?? LLM_ROLE_CODES);
  const hostRoles = new Set(deps.hostRoleCodes ?? HOST_ROLE_CODES);
  const autoRoles = new Set(deps.autoRoleCodes ?? AUTO_ROLE_CODES);
  const controlKinds = deps.controlKinds ?? CONTROL_KINDS;
  const kindOf = deps.normalizeKind ?? normalizeKind;
  const llmProviders = deps.llmProviders ?? LLM_CONNECTOR_PROVIDERS;
  const connectors = asObject(connectorsByRole);

  const problems = [];
  const add = (code, severity, stage, roleCode, message, recommendation) => {
    problems.push({
      code,
      severity,
      stageId: stage?.id ?? null,
      stageName: stage?.name ?? null,
      roleCode: roleCode ?? null,
      message,
      recommendation,
    });
  };

  const forks = [];
  const joins = [];

  for (const stage of asArray(stages)) {
    const kind = kindOf(stage?.kind);

    // Системные graph-ноды: не роль-исполнитель и не «этап без статуса» — собираем
    // для проверки парности и полностью исключаем из проверок (1) и (2).
    if (controlKinds.has(kind)) {
      if (kind === 'fork') forks.push(stage);
      else if (kind === 'join') joins.push(stage);
      continue;
    }

    // Дальше — только обычные включённые этапы.
    if (kind !== 'stage') continue;
    if (stage?.enabled !== true) continue;

    const roleCodes = asArray(stage?.roleCodes);
    const taskStatus = trimStr(stage?.taskStatus);

    // (2) обычный этап без статуса задачи — маршрут не сможет поставить на него задачу.
    if (!taskStatus) {
      add(
        'stage_missing_status', 'error', stage, null,
        `Этап «${stage?.name ?? '—'}» (kind=stage) не имеет статуса задачи (task_status пуст) — маршрут не сможет поставить задачу на этот этап.`,
        'Задайте task_status этапа из допустимых статусов маршрута.',
      );
    }

    for (const roleCode of roleCodes) {
      const hasExecutor = llmRoles.has(roleCode) || hostRoles.has(roleCode) || autoRoles.has(roleCode);

      // (1) роль без исполнителя — этап на ней зависнет.
      if (!hasExecutor) {
        add(
          'role_without_executor', 'error', stage, roleCode,
          `Роль ${roleCode} на этапе «${stage?.name ?? '—'}» не имеет исполнителя: она не входит ни в reasoning-роли, ни в host-роли, ни в auto-переходы маршрута.`,
          'Назначьте этапу роль-исполнителя (reasoning/host/auto) или удалите этап — иначе задача на нём зависнет.',
        );
        continue;
      }

      const conn = connectors[roleCode] ?? null;
      const provider = conn ? trimStr(conn.provider).toLowerCase() : '';

      // (3) host-роли назначен LLM-коннектор — несоответствие типа роли и коннектора.
      if (hostRoles.has(roleCode) && provider && llmProviders.has(provider)) {
        add(
          'host_role_llm_connector', 'error', stage, roleCode,
          `Host-роли ${roleCode} назначен LLM/reasoning-коннектор (провайдер ${provider}) — несоответствие типа роли и типа коннектора.`,
          `Снимите LLM-коннектор с host-роли ${roleCode}: она исполняется host-мостом (docker/git), а не ИИ-движком.`,
        );
      }

      // (4) reasoning-роль без включённого коннектора — исполнять некому.
      if (llmRoles.has(roleCode)) {
        const hasEnabledConnector = !!conn && conn.isEnabled === true && !!provider;
        if (!hasEnabledConnector) {
          add(
            'reasoning_role_no_connector', 'warning', stage, roleCode,
            `Reasoning-роль ${roleCode} на этапе «${stage?.name ?? '—'}» не имеет включённого коннектора/движка — исполнять некому.`,
            `Назначьте роли ${roleCode} включённый коннектор (движок) в карточке роли.`,
          );
        }
      }
    }
  }

  // (5) парность fork↔join: joinKey fork-узла должен указывать на stageKey join-узла
  //     (advanceForkNodes паркует родителя на current_stage_key = fork.join_key).
  const joinStageKeys = new Set(joins.map((j) => trimStr(j?.stageKey)).filter(Boolean));
  const forkJoinRefs = new Set(forks.map((f) => trimStr(f?.joinKey)).filter(Boolean));

  for (const fork of forks) {
    const ref = trimStr(fork?.joinKey);
    if (!ref || !joinStageKeys.has(ref)) {
      add(
        'fork_join_unpaired', 'warning', fork, null,
        `Fork-узел «${fork?.name ?? '—'}» не имеет парного join (joinKey=${ref || '—'}).`,
        'Проверьте парность fork↔join: joinKey fork-узла должен указывать на stageKey join-узла.',
      );
    }
  }
  for (const join of joins) {
    const key = trimStr(join?.stageKey);
    if (!key || !forkJoinRefs.has(key)) {
      add(
        'fork_join_unpaired', 'warning', join, null,
        `Join-узел «${join?.name ?? '—'}» (stageKey=${key || '—'}) не связан ни с одним fork.`,
        'Проверьте парность fork↔join: joinKey fork-узла должен указывать на stageKey join-узла.',
      );
    }
  }

  const error = problems.filter((p) => p.severity === 'error').length;
  const warning = problems.filter((p) => p.severity === 'warning').length;
  return {
    projectId: deps.projectId ?? null,
    problems,
    summary: { error, warning, total: problems.length, ok: problems.length === 0 },
  };
}

/**
 * Собрать отчёт для проекта: этапы + коннекторы ролей из БД.
 * GET /api/projects/:projectId/route-health.
 */
export async function getRouteHealth(s, projectId) {
  return withClient(clientConfig(s), async (c) => {
    const projectDbId = await resolveProjectId(c, projectId);
    const stages = await readStages(c, projectDbId);
    const rc = await c.query(
      `SELECT rc.role_code, cn.provider, cn.is_enabled
         FROM role_connectors rc
         JOIN connectors cn ON cn.id = rc.connector_id`,
    );
    const connectorsByRole = {};
    for (const row of rc.rows) {
      const code = row.role_code;
      if (!code) continue;
      const entry = { provider: row.provider ?? null, isEnabled: row.is_enabled === true };
      const prev = connectorsByRole[code];
      // Предпочитаем ВКЛЮЧЁННЫЙ коннектор: он определяет, есть ли исполнитель у
      // reasoning-роли (проверка reasoning_role_no_connector).
      if (!prev || (!prev.isEnabled && entry.isEnabled)) connectorsByRole[code] = entry;
    }
    return buildRouteHealthReport(stages, connectorsByRole, { projectId: projectDbId });
  });
}
