// PIPELINE-DYNAMIC-ROUTE-001 — чистый резолвер маршрута по этапам проекта.
//
// Маршрут роли определяется ПОРЯДКОМ этапов конкретного проекта, а не глобальной
// таблицей ROLE_FLOW. Роль не знает соседей: движок берёт следующую/предыдущую
// роль и статус задачи из этого маршрута. Ветвления (доработка, документация,
// архитектура) резолвятся по ТИПУ роли (roleKind) внутри этого же маршрута.
//
// Модуль чистый (без БД и сети) — покрыт юнит-тестами. БД-слой (db.js) лишь
// читает этапы проекта и передаёт их сюда, затем применяет решение.
import { ROLE_FLOW, roleKind } from './rolePipeline.js';

// Терминальные статусы — задачу из них не двигаем.
export const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/**
 * Построить плоский упорядоченный маршрут проекта из контрактов этапов.
 * stages: [{ position, enabled, taskStatus|scanner.taskStatus, roleCodes:[...] }].
 * Возвращает [{ roleCode, status, stageEnabled, stagePosition, index }] —
 * по записи на каждую (этап × роль), в порядке этапов и ролей внутри этапа.
 * Записи отключённых этапов СОХРАНЯЮТСЯ (stageEnabled=false), чтобы по ним
 * находить «текущую роль на отключённом этапе» и прокручивать её вперёд.
 */
export function buildRoute(stages = []) {
  const ordered = [...(Array.isArray(stages) ? stages : [])]
    .filter((s) => s && typeof s === 'object')
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const route = [];
  let index = 0;
  for (const stage of ordered) {
    const status = normalizeStatus(stage.taskStatus ?? stage?.scanner?.taskStatus);
    const codes = Array.isArray(stage.roleCodes) ? stage.roleCodes : [];
    for (const roleCode of codes) {
      route.push({
        roleCode,
        status,
        stageKey: stage.stageKey ?? stage.stage_key ?? null,
        stageEnabled: stage.enabled === true,
        stagePosition: stage.position ?? 0,
        index: index++,
      });
    }
  }
  return route;
}

function normalizeStatus(value) {
  const s = String(value ?? '').trim().toUpperCase();
  return s || null;
}

// Есть ли в маршруте хотя бы один пригодный (со статусом) включённый этап.
export function routeIsUsable(route = []) {
  return route.some((e) => e.stageEnabled && e.status);
}

// Первая включённая роль маршрута (точка входа новой/импортированной задачи).
export function firstStep(route = []) {
  return route.find((e) => e.stageEnabled && e.status) ?? null;
}

// Индекс ПЕРВОГО вхождения роли в маршрут (по любому этапу). -1, если нет.
function indexOfRole(route, roleCode, { currentStatus = null, currentStageKey = null } = {}) {
  const status = normalizeStatus(currentStatus);
  if (currentStageKey) {
    for (const e of route) {
      if (e.roleCode === roleCode && e.stageKey === currentStageKey) return e.index;
    }
  }
  if (status) {
    for (const e of route) {
      if (e.roleCode === roleCode && e.status === status) return e.index;
    }
  }
  for (const e of route) if (e.roleCode === roleCode) return e.index;
  return -1;
}

// Первая включённая запись СТРОГО после индекса idx.
// Роли-аналитики (kind=analyst, напр. FAILURE_ANALYST) — это branch-ЦЕЛЬ при
// ПРОВАЛЕ pipeline, а не линейный шаг маршрута. При движении ВПЕРЁД (в т.ч. после
// УСПЕШНОГО pipeline) их пропускаем: иначе FORWARD упрётся в аналитика, который
// вернёт задачу на доработку (REWORK) — и любая прошедшая pipeline задача
// зациклится Pipeline→Analyst→Programmer→… Аналитик остаётся включённым и
// по-прежнему достижим через BRANCH (findEnabled/byKind) на провале.
function nextEnabledAfter(route, idx) {
  for (const e of route) {
    if (e.index > idx && e.stageEnabled && e.status && roleKind(e.roleCode) !== 'analyst') return e;
  }
  return null;
}

/**
 * Движение ВПЕРЁД от роли roleCode: следующая включённая роль маршрута.
 * Возвращает запись маршрута или null (конец маршрута — задача завершается).
 * Если роли нет в маршруте — null (вызывающий применит канонический фолбэк).
 */
export function forwardFrom(route, roleCode, current = {}) {
  const idx = indexOfRole(route, roleCode, current);
  if (idx === -1) return undefined; // нет в маршруте → фолбэк
  return nextEnabledAfter(route, idx);
}

// Найти включённую запись по коду роли (для ветвления к конкретному коду).
export function findEnabled(route, roleCode) {
  return route.find((e) => e.roleCode === roleCode && e.stageEnabled && e.status) ?? null;
}

// Найти включённую запись по ТИПУ роли (roleKind) — для ветвления по типу.
function findEnabledByKind(route, kind, { before } = {}) {
  const limit = typeof before === 'number' ? before : Infinity;
  return route.find(
    (e) => e.stageEnabled && e.status && e.index < limit && roleKind(e.roleCode) === kind,
  ) ?? null;
}

/**
 * Цель доработки (REWORK) для роли roleCode: ближайшая ПРЕДШЕСТВУЮЩАЯ включённая
 * роль-исполнитель (kind=executor); если её нет — ближайшая проектная роль
 * (design) перед текущей; иначе — первая включённая роль маршрута.
 */
export function reworkTarget(route, roleCode, current = {}) {
  const idx = indexOfRole(route, roleCode, current);
  const before = idx === -1 ? Infinity : idx;
  // Идём с конца к началу среди записей до текущей.
  const prior = route.filter((e) => e.stageEnabled && e.status && e.index < before);
  const lastOfKind = (kind) => {
    for (let i = prior.length - 1; i >= 0; i -= 1) {
      if (roleKind(prior[i].roleCode) === kind) return prior[i];
    }
    return null;
  };
  return lastOfKind('executor') ?? lastOfKind('design') ?? prior[0] ?? firstStep(route);
}

/**
 * Канонический фолбэк по ROLE_FLOW (когда маршрут проекта неприменим): из
 * { nextRole, toStatus } глобальной таблицы. done — конец маршрута.
 */
export function canonicalForward(roleCode) {
  const flow = ROLE_FLOW[roleCode];
  if (!flow) return { nextRole: null, toStatus: 'BLOCKED', done: false, blocked: true };
  return { nextRole: flow.next, toStatus: flow.to, done: flow.next === null, blocked: false };
}

/**
 * Применить абстрактное решение роли к маршруту проекта.
 *
 * decision (из roleEngine.decideOutcome):
 *   { outcome: 'FORWARD' | 'REWORK' | 'BRANCH' | 'BLOCK',
 *     branchKind?, branchRole?, blockStatus? }
 *
 * route — маршрут проекта (buildRoute). Если он неприменим (нет этапов/статусов)
 * или текущей роли в нём нет — используется канонический фолбэк ROLE_FLOW.
 *
 * Возвращает { nextRole, toStatus, done, blocked, via } где via — источник
 * решения ('route' | 'canonical') для диагностики.
 */
export function resolveTransition(route, roleCode, decision, current = {}) {
  const usable = routeIsUsable(route);

  if (decision.outcome === 'BLOCK') {
    return { nextRole: null, toStatus: decision.blockStatus || 'BLOCKED', done: false, blocked: true, via: usable ? 'route' : 'canonical' };
  }

  if (!usable) return applyCanonical(roleCode);

  if (decision.outcome === 'BRANCH') {
    // Цель ветки: сперва по конкретному коду (если задан), затем по типу.
    const target =
      (decision.branchRole && findEnabled(route, decision.branchRole)) ||
      (decision.branchKind && findEnabledByKind(route, decision.branchKind)) ||
      null;
    if (target) {
      return { nextRole: target.roleCode, toStatus: target.status, done: false, blocked: false, via: 'route', nextStageKey: target.stageKey ?? null };
    }
    // Ветки нет в маршруте проекта — деградируем по branchFallback:
    //   'rework' (провал гейта без аналитика) — на доработку исполнителю;
    //   иначе — движение вперёд по маршруту.
    if (decision.branchFallback === 'rework') {
      const rt = reworkTarget(route, roleCode, current);
      if (rt) return { nextRole: rt.roleCode, toStatus: rt.status, done: false, blocked: false, via: 'route', nextStageKey: rt.stageKey ?? null };
    }
    return forwardOrFallback(route, roleCode, current);
  }

  if (decision.outcome === 'REWORK') {
    const target = reworkTarget(route, roleCode, current);
    if (target) {
      return { nextRole: target.roleCode, toStatus: target.status, done: false, blocked: false, via: 'route', nextStageKey: target.stageKey ?? null };
    }
    return applyCanonical(roleCode);
  }

  // FORWARD (по умолчанию).
  return forwardOrFallback(route, roleCode, current);
}

function forwardOrFallback(route, roleCode, current = {}) {
  const fwd = forwardFrom(route, roleCode, current);
  if (fwd === undefined) return applyCanonical(roleCode); // роли нет в маршруте
  if (fwd === null) return { nextRole: null, toStatus: 'DONE', done: true, blocked: false, via: 'route' };
  return { nextRole: fwd.roleCode, toStatus: fwd.status, done: false, blocked: false, via: 'route', nextStageKey: fwd.stageKey ?? null };
}

// Безопасный фолбэк, когда роли нет в маршруте проекта (частично настроенный
// маршрут). Полный канонический путь для НЕнастроенного маршрута db.js берёт
// напрямую из decideTransition — здесь лишь best-effort движение вперёд.
function applyCanonical(roleCode) {
  const c = canonicalForward(roleCode);
  return { ...c, via: 'canonical' };
}
