/**
 * SCHEME-GRAPH-LAYOUT-001 — раскладка блок-схемы «Разработка» ИЗ ГРАФА рёбер.
 *
 * Источник истины о маршруте — РЁБРА (`global_stage_edges` / `project_stage_edges`),
 * а не порядок массива узлов: реальный порядок узлов в БД обманчив (напр. Task Router
 * и Mini Architect добавлены миграцией в КОНЕЦ по position, но маршрут задают рёбра
 * intake→router→…). Раскладка обходит граф от входа по исходящим рёбрам:
 *
 *  - линейный участок → вертикальная ось узлов;
 *  - узел с ≥2 исходящими рёбрами → ветвление: fork (параллельные ветки, рёбра без
 *    condition) или condition/decision (взаимоисключающие ветки с подписью condition,
 *    напр. Router: small→Mini Architect / иначе→Architect). Ветки сходятся в merge
 *    (пост-доминаторе): для fork это его joinKey, для condition — ближайший общий
 *    потомок веток;
 *  - управляющий узел fork/condition с <2 исходящими помечается неполным (TODO);
 *  - узлы, недостижимые из входа графа, возвращаются отдельно (detached) — их не
 *    теряем, а показываем группой TODO;
 *  - обход защищён от циклов и битых рёбер (guard по числу узлов).
 *
 * Если валидных рёбер нет — режим linear-fallback (обратная совместимость): каждый
 * узел отдельным элементом в порядке массива. Fallback изолирован от graph-mode.
 */
import type { SchemeEdge, Stage, StageKind } from '../../types/project';

export interface PlacedNode {
  stage: Stage;
  /** Индекс узла в исходном списке stages (для drag-reorder и модалок). */
  index: number;
}

/** Ветка узла-ветвления: её условие (подпись) и упорядоченные элементы до merge. */
export interface LayoutBranch {
  /** Метка condition на ребре в голову ветки; null — безусловная ветка (fork / fallback). */
  condition: string | null;
  /** Элементы ветки (цепочка/вложенные ветвления) от головы ветки до merge (исключая merge). */
  items: LayoutItem[];
}

export type LayoutItem =
  | {
      type: 'node';
      node: PlacedNode;
      /** Подпись condition на единственном исходящем ребре (для метки связи); обычно null. */
      edgeCondition: string | null;
      /** Реальный конец маршрута: у узла нет исходящих рёбер. */
      terminal: boolean;
    }
  | {
      type: 'branch';
      /** Родитель развилки (fork / condition / обычный узел с несколькими рёбрами). */
      parent: PlacedNode;
      /** fork — параллельные ветки; condition — взаимоисключающие ветки по исходу. */
      kind: 'fork' | 'condition';
      branches: LayoutBranch[];
      /** Узел схождения веток (пост-доминатор). null — ветки расходятся без слияния. */
      merge: PlacedNode | null;
      /** Узел-ветвление неполон (управляющий fork/condition с <2 исходящими рёбрами). */
      incomplete: boolean;
    };

export interface SchemeLayout {
  /** graph — раскладка по рёбрам; linear — фолбэк по порядку узлов (нет валидных рёбер). */
  mode: 'graph' | 'linear';
  /** Основная ось раскладки (от входа графа). */
  items: LayoutItem[];
  /** Узлы, недостижимые из входа графа — рисуются отдельной группой (TODO: detached). */
  detached: PlacedNode[];
  /** В графе обнаружен цикл (обход прерван защитой) — для пометки в UI. */
  hasCycle: boolean;
}

/** Все ключи рёбер ссылаются на существующие stageKey текущих узлов (и рёбра есть). */
export function edgesMatchStages(stages: Stage[], edges: SchemeEdge[]): boolean {
  if (!edges.length) return false;
  const keys = new Set(stages.map((s) => s.stageKey).filter(Boolean) as string[]);
  return edges.every((e) => keys.has(e.fromKey) && keys.has(e.toKey));
}

interface OutEdge {
  toKey: string;
  condition: string | null;
  position: number;
}

/**
 * Построить раскладку блок-схемы. Если рёбер нет/они не соответствуют узлам —
 * linear-fallback (каждый узел отдельным элементом). Иначе — обход графа от входа.
 */
export function buildSchemeLayout(stages: Stage[], edges: SchemeEdge[] = []): SchemeLayout {
  const placed = stages.map((stage, index) => ({ stage, index }));

  const byKey = new Map<string, PlacedNode>();
  for (const pn of placed) {
    if (pn.stage.stageKey) byKey.set(pn.stage.stageKey, pn);
  }

  // Исходящие рёбра узла, отсортированы по position (стабильный порядок веток).
  // Битые рёбра (концы не ссылаются на существующий узел) отбрасываем — UI не падает.
  const outByKey = new Map<string, OutEdge[]>();
  let usableEdges = 0;
  for (const e of edges) {
    if (!byKey.has(e.fromKey) || !byKey.has(e.toKey)) continue;
    usableEdges += 1;
    if (!outByKey.has(e.fromKey)) outByKey.set(e.fromKey, []);
    outByKey.get(e.fromKey)!.push({
      toKey: e.toKey,
      condition: e.condition != null && String(e.condition).trim() ? String(e.condition).trim() : null,
      position: e.position ?? 0,
    });
  }
  for (const arr of outByKey.values()) arr.sort((a, b) => a.position - b.position);

  // Нет ни одного пригодного ребра (пусто или все битые) → linear-fallback.
  if (usableEdges === 0) {
    return {
      mode: 'linear',
      items: placed.map((node) => ({ type: 'node', node, edgeCondition: null, terminal: false })),
      detached: [],
      hasCycle: false,
    };
  }

  const outgoing = (key: string): OutEdge[] => outByKey.get(key) ?? [];

  // Входящие степени — для выбора входа графа.
  const inDegree = new Map<string, number>();
  for (const key of byKey.keys()) inDegree.set(key, 0);
  for (const arr of outByKey.values()) {
    for (const e of arr) inDegree.set(e.toKey, (inDegree.get(e.toKey) ?? 0) + 1);
  }

  const nodeCount = byKey.size;

  // Вход графа: первый по порядку узлов узел без входящих рёбер (напр. Scanner);
  // если такого нет (цикл охватывает всё) — просто первый узел.
  const entry =
    placed.find((pn) => pn.stage.stageKey && (inDegree.get(pn.stage.stageKey) ?? 0) === 0) ??
    placed[0];

  const visited = new Set<string>();
  let hasCycle = false;

  // Множество узлов, достижимых из start вперёд по рёбрам (с защитой от циклов).
  const forwardReachable = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue: string[] = [start];
    let guard = 0;
    while (queue.length && guard <= nodeCount) {
      guard += 1;
      const k = queue.shift()!;
      if (seen.has(k)) continue;
      seen.add(k);
      for (const e of outgoing(k)) if (!seen.has(e.toKey)) queue.push(e.toKey);
    }
    return seen;
  };

  // Узел схождения ветвления (ближайший общий пост-доминатор). Для fork — явный
  // joinKey (если валиден); иначе — ближайший общий потомок всех веток (BFS от родителя).
  const findMerge = (parent: PlacedNode, targets: string[]): string | null => {
    const explicitJoin = parent.stage.joinKey;
    if (explicitJoin && byKey.has(explicitJoin)) return explicitJoin;
    if (targets.length < 2) return null;

    const reach = targets.map((t) => forwardReachable(t));
    let common = new Set<string>(reach[0]);
    for (let i = 1; i < reach.length; i += 1) {
      common = new Set([...common].filter((k) => reach[i]!.has(k)));
    }
    if (!common.size) return null;

    // Ближайший общий потомок по BFS от родителя (первый встреченный из common).
    const queue: string[] = [...targets];
    const seen = new Set<string>([parent.stage.stageKey!]);
    let guard = 0;
    while (queue.length && guard <= nodeCount + 1) {
      guard += 1;
      const k = queue.shift()!;
      if (seen.has(k)) continue;
      seen.add(k);
      if (common.has(k)) return k;
      for (const e of outgoing(k)) queue.push(e.toKey);
    }
    return null;
  };

  // Обход линейного сегмента от startKey до stop (исключая ключи из stop).
  const walk = (startKey: string, stop: Set<string>): LayoutItem[] => {
    const items: LayoutItem[] = [];
    let cur: string | null = startKey;
    let guard = 0;
    while (cur && !stop.has(cur) && guard <= nodeCount) {
      guard += 1;
      if (visited.has(cur)) {
        hasCycle = true; // узел уже нарисован — цикл/повторное схождение, дальше не идём
        break;
      }
      const node = byKey.get(cur);
      if (!node) break;
      visited.add(cur);

      const outs = outgoing(cur);
      const kind: StageKind = node.stage.kind ?? 'stage';
      const isControlBranch = kind === 'fork' || kind === 'condition';

      // Ветвление по рёбрам: развилка при ≥2 исходящих. Тип развилки берём из РЁБЕР —
      // если у рёбер есть condition, это decision (взаимоисключающие ветки с подписью),
      // иначе параллельный fork. (Роль/имя узла как источник маршрута НЕ используем.)
      if (outs.length >= 2) {
        const branchKind: 'fork' | 'condition' = outs.some((e) => e.condition) ? 'condition' : 'fork';
        const mergeKey = findMerge(node, outs.map((e) => e.toKey));
        const branchStop = mergeKey ? new Set([...stop, mergeKey]) : stop;
        const branches: LayoutBranch[] = outs.map((e) => ({
          condition: e.condition,
          items: walk(e.toKey, branchStop),
        }));
        items.push({
          type: 'branch',
          parent: node,
          kind: branchKind,
          branches,
          merge: mergeKey ? byKey.get(mergeKey) ?? null : null,
          incomplete: false,
        });
        if (mergeKey && !stop.has(mergeKey)) {
          cur = mergeKey; // спина продолжается из merge (он ещё не посещён)
          continue;
        }
        break; // ветки расходятся без слияния — спины дальше нет
      }

      // Управляющий узел ветвления с <2 исходящими рёбрами — неполный (TODO).
      if (isControlBranch) {
        items.push({
          type: 'branch',
          parent: node,
          kind: kind === 'condition' ? 'condition' : 'fork',
          branches: outs.map((e) => ({ condition: e.condition, items: walk(e.toKey, stop) })),
          merge: null,
          incomplete: true,
        });
        break;
      }

      // Обычный узел (stage/join) — линейное звено оси.
      items.push({
        type: 'node',
        node,
        edgeCondition: outs[0]?.condition ?? null,
        terminal: outs.length === 0,
      });
      if (!outs.length) break;
      cur = outs[0]!.toKey;
    }
    return items;
  };

  const items = entry ? walk(entry.stage.stageKey!, new Set()) : [];

  // Недостижимые из входа узлы — не теряем, отдаём отдельной группой (в порядке массива).
  const detached = placed.filter((pn) => !pn.stage.stageKey || !visited.has(pn.stage.stageKey));

  return { mode: 'graph', items, detached, hasCycle };
}
