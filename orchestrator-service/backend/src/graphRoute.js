// FORK-JOIN-001 — чистый резолвер маршрута ПО РЁБРАМ блок-схемы (граф-режим).
//
// Линейная маршрутизация (projectRoute.js) ведёт задачу по ПОРЯДКУ этапов. Когда
// у проекта есть рёбра (project_stage_edges), задача с заданным current_stage_key
// идёт ПО СВЯЗЯМ графа: из текущего узла в следующий по исходящему ребру. Узлы
// fork/join обрабатывают подметатели (db.js), здесь — только выбор следующего узла.
//
// Модуль чистый (без БД/сети) — покрыт юнит-тестами. db.js загружает узлы и рёбра
// проекта и передаёт их сюда в виде простых структур.
import { roleKind } from './rolePipeline.js';

// Сопоставление абстрактного исхода роли с меткой ветки узла condition.
// FORWARD/успех → 'success'; провал/блок → 'failure'; иначе — null (без метки).
//
// TASK-ROUTER-001: роль может задать ЯВНУЮ метку ветки (decision.branchLabel), напр.
// Task Router кладёт туда выбранный route (small|medium|large). Тогда выбор исходящего
// ребра идёт ПО НЕЙ (edge.condition === branchLabel), а не по success/failure — это и
// есть условная развилка small → MINI_ARCHITECT / иначе → ARCHITECT через рёбра графа.
// Прочие роли метку не задают → прежнее поведение success/failure не меняется.
export function outcomeLabel(decision) {
  const explicit = decision?.branchLabel;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const o = decision?.outcome;
  if (o === 'BLOCK') return 'failure';
  if (o === 'REWORK' || o === 'BRANCH') return 'failure';
  return 'success';
}

/**
 * Построить граф из плоских структур:
 *   nodes: [{ stageKey, kind, roleCode, roleId, status, joinKey, enabled }]
 *   edges: [{ fromKey, toKey, condition, position }]
 * Возвращает { nodeByKey: Map, edgesByFrom: Map(fromKey → отсортированные рёбра) }.
 */
export function buildGraph(nodes = [], edges = []) {
  const nodeByKey = new Map();
  for (const n of Array.isArray(nodes) ? nodes : []) {
    if (n && n.stageKey) nodeByKey.set(n.stageKey, n);
  }
  const edgesByFrom = new Map();
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || !e.fromKey || !e.toKey) continue;
    if (!edgesByFrom.has(e.fromKey)) edgesByFrom.set(e.fromKey, []);
    edgesByFrom.get(e.fromKey).push({
      toKey: e.toKey,
      condition: e.condition ?? null,
      position: e.position ?? 0,
    });
  }
  for (const arr of edgesByFrom.values()) arr.sort((a, b) => a.position - b.position);
  return { nodeByKey, edgesByFrom };
}

// Исходящие рёбра узла (отсортированы по position); [] — узел-сток.
export function outgoing(graph, fromKey) {
  return graph.edgesByFrom.get(fromKey) ?? [];
}

// Ключи веток узла fork (цели всех исходящих рёбер).
export function forkBranchKeys(graph, forkKey) {
  return outgoing(graph, forkKey).map((e) => e.toKey);
}

// Целевой ключ ОДНОГО перехода из fromKey по метке исхода (success/failure), без
// пропуска аналитиков. Узел с рёбрами-условиями (condition) ветвится по метке —
// это верно не только для kind='condition', но и для обычного узла-исполнителя
// (напр. Pipeline Service: success→fork, failure→analyst). Узлы без условий идут
// по первому ребру (position). null — узел-сток.
function pickEdgeKey(graph, fromKey, label) {
  const edges = outgoing(graph, fromKey);
  if (!edges.length) return null;
  if (edges.some((e) => e.condition)) {
    const match = edges.find((e) => e.condition === label);
    const fallback = edges.find((e) => !e.condition) ?? edges[0];
    return (match ?? fallback).toKey;
  }
  return edges[0].toKey;
}

/**
 * Следующий узел из fromKey по исходам decision. Для узла с рёбрами-условиями —
 * выбор по outcomeLabel(decision) (success/failure); иначе — первое исходящее ребро.
 *
 * FORWARD-NO-ANALYST-001: успешный путь НЕ приземляется на роль-аналитика (узел
 * разбора провала достижим ТОЛЬКО по ветке 'failure'). Если следующий узел
 * оказался аналитиком при успехе (частый случай линейно сгенерированных рёбер, где
 * Failure Analyst стоит по позиции сразу за Pipeline Service), прокручиваем его
 * вперёд — как линейный nextEnabledAfter. null — нет перехода (задача завершается).
 */
export function nextNodeKey(graph, fromKey, decision = {}) {
  const label = outcomeLabel(decision);
  let key = fromKey;
  const guard = graph.nodeByKey.size + 1;
  for (let i = 0; i < guard; i += 1) {
    const next = pickEdgeKey(graph, key, label);
    if (!next) return null;
    if (label === 'success' && roleKind(graph.nodeByKey.get(next)?.roleCode) === 'analyst') {
      key = next; // зелёный путь минует аналитика
      continue;
    }
    return next;
  }
  return null;
}

/**
 * FA-REWORK-ROUTE-001 — цель доработки (REWORK) в граф-режиме: ближайший
 * ПРЕДШЕСТВУЮЩИЙ узел-исполнитель (roleKind='executor') по ОБРАТНЫМ рёбрам графа;
 * если исполнителя нет — ближайшая проектная роль (design). Нужен, чтобы вердикт
 * аналитика «на доработку» РЕАЛЬНО вернул задачу назад к Программисту, а не был
 * проглочен следующим узлом (fork/join) при движении вперёд. null — цели нет.
 */
export function reworkNodeKey(graph, fromKey) {
  const incoming = new Map();
  for (const [from, edges] of graph.edgesByFrom) {
    for (const e of edges) {
      if (!incoming.has(e.toKey)) incoming.set(e.toKey, []);
      incoming.get(e.toKey).push(from);
    }
  }
  const seen = new Set([fromKey]);
  let frontier = [...(incoming.get(fromKey) ?? [])];
  let designFallback = null;
  const guard = graph.nodeByKey.size + 1;
  for (let depth = 0; depth < guard && frontier.length; depth += 1) {
    const nextFrontier = [];
    for (const key of frontier) {
      if (seen.has(key)) continue;
      seen.add(key);
      const kind = roleKind(graph.nodeByKey.get(key)?.roleCode);
      if (kind === 'executor') return key; // ближайший исполнитель — приоритетно
      if (kind === 'design' && !designFallback) designFallback = key;
      for (const p of incoming.get(key) ?? []) if (!seen.has(p)) nextFrontier.push(p);
    }
    frontier = nextFrontier;
  }
  return designFallback;
}

// Узел по ключу (или null).
export function nodeByKey(graph, key) {
  return graph.nodeByKey.get(key) ?? null;
}
