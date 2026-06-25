// FORK-JOIN-001 — чистый резолвер маршрута ПО РЁБРАМ блок-схемы (граф-режим).
//
// Линейная маршрутизация (projectRoute.js) ведёт задачу по ПОРЯДКУ этапов. Когда
// у проекта есть рёбра (project_stage_edges), задача с заданным current_stage_key
// идёт ПО СВЯЗЯМ графа: из текущего узла в следующий по исходящему ребру. Узлы
// fork/join обрабатывают подметатели (db.js), здесь — только выбор следующего узла.
//
// Модуль чистый (без БД/сети) — покрыт юнит-тестами. db.js загружает узлы и рёбра
// проекта и передаёт их сюда в виде простых структур.

// Сопоставление абстрактного исхода роли с меткой ветки узла condition.
// FORWARD/успех → 'success'; провал/блок → 'failure'; иначе — null (без метки).
export function outcomeLabel(decision) {
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

/**
 * Следующий узел из fromKey по исходам decision. Для узла condition выбирается
 * ребро с меткой, совпадающей с outcomeLabel(decision) (или безусловное/первое
 * как фолбэк). Для остальных узлов — первое исходящее ребро. null — нет перехода
 * (сток → задача завершается).
 */
export function nextNodeKey(graph, fromKey, decision = {}) {
  const edges = outgoing(graph, fromKey);
  if (!edges.length) return null;
  const node = graph.nodeByKey.get(fromKey);
  if (node && node.kind === 'condition') {
    const label = outcomeLabel(decision);
    const match = edges.find((e) => e.condition && e.condition === label);
    const fallback = edges.find((e) => !e.condition) ?? edges[0];
    return (match ?? fallback).toKey;
  }
  return edges[0].toKey;
}

// Узел по ключу (или null).
export function nodeByKey(graph, key) {
  return graph.nodeByKey.get(key) ?? null;
}
