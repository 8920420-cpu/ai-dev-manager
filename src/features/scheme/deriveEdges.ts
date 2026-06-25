/**
 * FORK-JOIN-001 — авто-вывод рёбер блок-схемы из упорядоченного списка узлов.
 *
 * Рёбра НЕ рисуются вручную: топология выводится из порядка узлов + маркеров
 * fork/join. Узел fork и идущие за ним этапы-ветки до ближайшего join образуют
 * параллельные ветки; на каждой ветке — один этап (MVP). Если узлов fork/join
 * нет — рёбра не генерируются (схема остаётся линейной, маршрут по позиции).
 */
import type { SchemeEdge, Stage } from '../../types/project';

function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Фолбэк (UUID-подобный) — на случай отсутствия crypto.randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface DerivedScheme {
  /** Узлы с гарантированными stageKey (и joinKey на fork). */
  stages: Stage[];
  /** Авто-рёбра (пустой массив для линейной схемы без fork/join). */
  edges: SchemeEdge[];
}

/**
 * Вывести рёбра из узлов. Возвращает копию узлов (с проставленными stageKey и
 * joinKey на fork) и список рёбер. Для схемы без управляющих узлов edges = [].
 */
export function deriveSchemeEdges(stages: Stage[]): DerivedScheme {
  const withKeys: Stage[] = stages.map((s) => ({ ...s, stageKey: s.stageKey ?? newKey() }));
  const hasControl = withKeys.some((s) => (s.kind ?? 'stage') !== 'stage');
  if (!hasControl) return { stages: withKeys, edges: [] };

  const edges: SchemeEdge[] = [];
  let pos = 0;
  const addEdge = (fromKey: string, toKey: string, condition: string | null = null) => {
    edges.push({ fromKey, toKey, condition, position: pos++ });
  };

  const n = withKeys.length;
  let prev: string | null = null;
  let i = 0;
  while (i < n) {
    const node = withKeys[i]!;
    const key = node.stageKey!;
    if (node.kind === 'fork') {
      // Ближайший join справа — парный барьер; этапы между ними — ветки.
      let j = i + 1;
      while (j < n && withKeys[j]!.kind !== 'join') j += 1;
      const join = j < n ? withKeys[j]! : null;
      const branches = withKeys.slice(i + 1, j).filter((b) => (b.kind ?? 'stage') !== 'join');
      if (prev) addEdge(prev, key);
      if (join && branches.length) {
        node.joinKey = join.stageKey;
        for (const b of branches) {
          addEdge(key, b.stageKey!);
          addEdge(b.stageKey!, join.stageKey!);
        }
        prev = join.stageKey!;
        i = j + 1;
        continue;
      }
      // Некорректный fork (нет join/веток) — трактуем линейно, не ломаем схему.
      prev = key;
      i += 1;
      continue;
    }
    if (prev) addEdge(prev, key);
    prev = key;
    i += 1;
  }

  return { stages: withKeys, edges };
}
