/**
 * FORK-JOIN-001 — раскладка блок-схемы для рендера: группирует участок
 * fork → … → join в параллельные ветки, чтобы UI рисовал их рядом (колонками),
 * а не одной вертикальной линией.
 *
 * Источник истины о ветвлении — РЁБРА графа (не порядок узлов): по исходящим
 * рёбрам fork находятся головы веток, каждая ветка прослеживается по связям до
 * парного join. Поэтому многоузловые ветки (напр. Auditor → Keeper) показываются
 * как одна колонка, а не как отдельные параллельные узлы.
 */
import type { SchemeEdge, Stage } from '../../types/project';

export interface PlacedNode {
  stage: Stage;
  /** Индекс узла в исходном списке stages (для drag-reorder и модалок). */
  index: number;
}

export type LayoutItem =
  | { type: 'node'; node: PlacedNode }
  | {
      type: 'parallel';
      fork: PlacedNode;
      /** Ветки: каждая — упорядоченная цепочка узлов от fork до join (без них). */
      branches: PlacedNode[][];
      join: PlacedNode;
    };

/** Все ключи рёбер ссылаются на существующие stageKey текущих узлов. */
export function edgesMatchStages(stages: Stage[], edges: SchemeEdge[]): boolean {
  if (!edges.length) return false;
  const keys = new Set(stages.map((s) => s.stageKey).filter(Boolean) as string[]);
  return edges.every((e) => keys.has(e.fromKey) && keys.has(e.toKey));
}

/**
 * Построить раскладку. Если рёбер нет/они не соответствуют узлам — возвращает
 * чисто линейную раскладку (каждый узел отдельным элементом). Узел fork с
 * найденным парным join и ветками сворачивается в элемент 'parallel'.
 */
export function buildSchemeLayout(stages: Stage[], edges: SchemeEdge[] = []): LayoutItem[] {
  const linear: LayoutItem[] = stages.map((stage, index) => ({ type: 'node', node: { stage, index } }));
  if (!edgesMatchStages(stages, edges)) return linear;

  const byKey = new Map<string, PlacedNode>();
  stages.forEach((stage, index) => {
    if (stage.stageKey) byKey.set(stage.stageKey, { stage, index });
  });

  // Исходящие рёбра по узлу (упорядочены по position) — порядок веток стабилен.
  const out = new Map<string, string[]>();
  for (const e of [...edges].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))) {
    if (!out.has(e.fromKey)) out.set(e.fromKey, []);
    out.get(e.fromKey)!.push(e.toKey);
  }

  const items: LayoutItem[] = [];
  const consumed = new Set<number>();

  for (let i = 0; i < stages.length; i += 1) {
    if (consumed.has(i)) continue;
    const stage = stages[i]!;
    const forkKey = stage.stageKey;
    if ((stage.kind ?? 'stage') === 'fork' && forkKey && stage.joinKey && byKey.has(stage.joinKey)) {
      const joinKey = stage.joinKey;
      const join = byKey.get(joinKey)!;
      const heads = out.get(forkKey) ?? [];
      const branches: PlacedNode[][] = [];
      const guard = stages.length + 1; // защита от циклов
      for (const head of heads) {
        const path: PlacedNode[] = [];
        let cur: string | null = head;
        let steps = 0;
        while (cur && cur !== joinKey && steps < guard) {
          const pn = byKey.get(cur);
          if (!pn) break;
          path.push(pn);
          const next: string[] = out.get(cur) ?? [];
          cur = next[0] ?? null;
          steps += 1;
        }
        if (path.length) branches.push(path);
      }
      // Корректный fork: есть парный join и хотя бы одна ветка — сворачиваем в band.
      if (branches.length) {
        consumed.add(i);
        consumed.add(join.index);
        for (const br of branches) for (const pn of br) consumed.add(pn.index);
        items.push({ type: 'parallel', fork: { stage, index: i }, branches, join });
        continue;
      }
    }
    items.push({ type: 'node', node: { stage, index: i } });
  }

  return items;
}
