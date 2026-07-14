import { describe, expect, it } from 'vitest';
import { buildSchemeLayout, edgesMatchStages, type LayoutItem } from './schemeLayout';
import { deriveSchemeEdges } from './deriveEdges';
import type { SchemeEdge, Stage, StageKind } from '../../types/project';

function node(id: string, kind: StageKind = 'stage', extra: Partial<Stage> = {}): Stage {
  return { id, kind, stageKey: id, name: id, roleIds: [], enabled: true, ...extra };
}

// Удобные предикаты типов элементов раскладки.
function asNode(item: LayoutItem | undefined) {
  if (!item || item.type !== 'node') throw new Error('ожидался node-элемент');
  return item;
}
function asBranch(item: LayoutItem | undefined) {
  if (!item || item.type !== 'branch') throw new Error('ожидался branch-элемент');
  return item;
}

describe('buildSchemeLayout — режимы', () => {
  it('без рёбер → linear-fallback (каждый узел отдельным элементом)', () => {
    const stages = [node('a'), node('b'), node('c')];
    const layout = buildSchemeLayout(stages, []);
    expect(layout.mode).toBe('linear');
    expect(layout.items).toHaveLength(3);
    expect(layout.items.every((i) => i.type === 'node')).toBe(true);
    expect(layout.detached).toEqual([]);
  });

  it('линейная цепочка по рёбрам → graph-mode, последний узел терминальный', () => {
    const stages = [node('a'), node('b'), node('c')];
    const edges: SchemeEdge[] = [
      { fromKey: 'a', toKey: 'b', position: 0 },
      { fromKey: 'b', toKey: 'c', position: 1 },
    ];
    const layout = buildSchemeLayout(stages, edges);
    expect(layout.mode).toBe('graph');
    expect(layout.items.map((i) => i.type)).toEqual(['node', 'node', 'node']);
    expect(asNode(layout.items[0]).terminal).toBe(false);
    expect(asNode(layout.items[2]).terminal).toBe(true); // реальный конец маршрута
    expect(layout.detached).toEqual([]);
    expect(layout.hasCycle).toBe(false);
  });
});

describe('buildSchemeLayout — condition-развилка (несколько исходящих рёбер)', () => {
  it('Task Router: small→Mini Architect / иначе→Architect, схождение на Programmer', () => {
    // Реальная топология из миграции 0062: развилка выражена УСЛОВНЫМИ рёбрами.
    const stages = [
      node('intake'),
      node('router'),
      node('mini'),
      node('arch'),
      node('prog'),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'intake', toKey: 'router', position: 0 },
      { fromKey: 'router', toKey: 'mini', condition: 'small', position: 0 },
      { fromKey: 'router', toKey: 'arch', condition: null, position: 1 },
      { fromKey: 'mini', toKey: 'prog', position: 0 },
      { fromKey: 'arch', toKey: 'prog', position: 0 },
    ];
    const layout = buildSchemeLayout(stages, edges);
    expect(layout.mode).toBe('graph');

    // intake · branch(router) · prog(terminal).
    expect(layout.items.map((i) => i.type)).toEqual(['node', 'branch', 'node']);
    const branch = asBranch(layout.items[1]);
    expect(branch.kind).toBe('condition'); // тип развилки берётся из наличия condition у рёбер
    expect(branch.parent.stage.id).toBe('router');
    expect(branch.incomplete).toBe(false);
    // Второе исходящее ребро НЕ теряется: обе ветки на месте, с подписями.
    expect(branch.branches).toHaveLength(2);
    expect(branch.branches[0]!.condition).toBe('small');
    expect(branch.branches[0]!.items.map((i) => asNode(i).node.stage.id)).toEqual(['mini']);
    expect(branch.branches[1]!.condition).toBe(null); // fallback (по умолчанию)
    expect(branch.branches[1]!.items.map((i) => asNode(i).node.stage.id)).toEqual(['arch']);
    // Схождение веток — Programmer (ближайший общий потомок), он же следующий узел оси.
    expect(branch.merge?.stage.id).toBe('prog');
    expect(asNode(layout.items[2]).node.stage.id).toBe('prog');
    expect(asNode(layout.items[2]).terminal).toBe(true);
  });
});

describe('buildSchemeLayout — fork/join', () => {
  it('fork→[Auditor→Keeper]‖[Git]→join→end: параллельные ветки, схождение на join', () => {
    const stages = [
      node('FA'),
      node('F', 'fork', { joinKey: 'J' }),
      node('DA'),
      node('DK'),
      node('GI'),
      node('J', 'join'),
      node('END'),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'FA', toKey: 'F', position: 0 },
      { fromKey: 'F', toKey: 'DA', position: 0 },
      { fromKey: 'F', toKey: 'GI', position: 1 },
      { fromKey: 'DA', toKey: 'DK', position: 0 },
      { fromKey: 'DK', toKey: 'J', position: 0 },
      { fromKey: 'GI', toKey: 'J', position: 0 },
      { fromKey: 'J', toKey: 'END', position: 0 },
    ];
    const layout = buildSchemeLayout(stages, edges);

    // FA · branch(fork) · J · END(terminal).
    expect(layout.items.map((i) => i.type)).toEqual(['node', 'branch', 'node', 'node']);
    const branch = asBranch(layout.items[1]);
    expect(branch.kind).toBe('fork'); // рёбра без condition → параллельный fork
    expect(branch.parent.stage.id).toBe('F');
    expect(branch.merge?.stage.id).toBe('J');
    expect(branch.branches).toHaveLength(2);
    // Ветка 1 — цепочка Auditor→Keeper одной колонкой; ветка 2 — одиночный Git.
    expect(branch.branches[0]!.items.map((i) => asNode(i).node.stage.id)).toEqual(['DA', 'DK']);
    expect(branch.branches[1]!.items.map((i) => asNode(i).node.stage.id)).toEqual(['GI']);
    // join нарисован узлом оси после веток, а следом — реальный конец.
    expect(asNode(layout.items[2]).node.stage.id).toBe('J');
    expect(asNode(layout.items[3]).node.stage.id).toBe('END');
    expect(asNode(layout.items[3]).terminal).toBe(true);
  });

  it('пост-join Git Integrator после join виден как следующий узел оси', () => {
    const stages = [
      node('F', 'fork', { joinKey: 'J' }),
      node('A'),
      node('B'),
      node('J', 'join'),
      node('postGI'),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'F', toKey: 'A', position: 0 },
      { fromKey: 'F', toKey: 'B', position: 1 },
      { fromKey: 'A', toKey: 'J', position: 0 },
      { fromKey: 'B', toKey: 'J', position: 0 },
      { fromKey: 'J', toKey: 'postGI', position: 0 },
    ];
    const layout = buildSchemeLayout(stages, edges);
    // branch(fork) · J · postGI(terminal).
    expect(layout.items.map((i) => i.type)).toEqual(['branch', 'node', 'node']);
    expect(asNode(layout.items[1]).node.stage.id).toBe('J');
    expect(asNode(layout.items[2]).node.stage.id).toBe('postGI');
    expect(asNode(layout.items[2]).terminal).toBe(true);
  });
});

describe('buildSchemeLayout — устойчивость', () => {
  it('битое ребро (конец без узла) отбрасывается, остальной граф строится', () => {
    const stages = [node('a'), node('b')];
    const edges: SchemeEdge[] = [
      { fromKey: 'a', toKey: 'b', position: 0 },
      { fromKey: 'b', toKey: 'ghost', position: 1 }, // ghost — несуществующий узел
    ];
    const layout = buildSchemeLayout(stages, edges);
    expect(layout.mode).toBe('graph');
    expect(layout.items.map((i) => asNode(i).node.stage.id)).toEqual(['a', 'b']);
    // b — терминальный: его единственное исходящее ребро было битым и отброшено.
    expect(asNode(layout.items[1]).terminal).toBe(true);
  });

  it('цикл a→b→c→a не роняет UI: обход прерывается, hasCycle=true', () => {
    const stages = [node('a'), node('b'), node('c')];
    const edges: SchemeEdge[] = [
      { fromKey: 'a', toKey: 'b', position: 0 },
      { fromKey: 'b', toKey: 'c', position: 1 },
      { fromKey: 'c', toKey: 'a', position: 2 },
    ];
    const layout = buildSchemeLayout(stages, edges);
    expect(layout.mode).toBe('graph');
    expect(layout.hasCycle).toBe(true);
    expect(layout.items.map((i) => asNode(i).node.stage.id)).toEqual(['a', 'b', 'c']);
  });

  it('недостижимый узел не теряется — попадает в detached', () => {
    const stages = [node('a'), node('b'), node('orphan')];
    const edges: SchemeEdge[] = [{ fromKey: 'a', toKey: 'b', position: 0 }];
    const layout = buildSchemeLayout(stages, edges);
    expect(layout.items.map((i) => asNode(i).node.stage.id)).toEqual(['a', 'b']);
    expect(layout.detached.map((p) => p.stage.id)).toEqual(['orphan']);
  });

  it('управляющий узел condition с одной ветвью помечается incomplete (TODO)', () => {
    const stages = [node('X'), node('C', 'condition'), node('Y')];
    const edges: SchemeEdge[] = [
      { fromKey: 'X', toKey: 'C', position: 0 },
      { fromKey: 'C', toKey: 'Y', position: 0 },
    ];
    const layout = buildSchemeLayout(stages, edges);
    const branch = asBranch(layout.items[1]);
    expect(branch.incomplete).toBe(true);
    expect(branch.branches).toHaveLength(1);
  });
});

describe('buildSchemeLayout — совместимость с deriveSchemeEdges', () => {
  it('рёбра из deriveSchemeEdges (fork с одноузловыми ветками) раскладываются в fork-развилку', () => {
    const stages = [node('A'), node('F', 'fork'), node('B'), node('C'), node('J', 'join'), node('D')];
    const { stages: out, edges } = deriveSchemeEdges(stages);
    expect(edgesMatchStages(out, edges)).toBe(true);
    const layout = buildSchemeLayout(out, edges);
    expect(layout.items.map((i) => i.type)).toEqual(['node', 'branch', 'node', 'node']);
    const branch = asBranch(layout.items[1]);
    expect(branch.kind).toBe('fork');
    expect(branch.branches.map((b) => b.items.map((i) => asNode(i).node.stage.id))).toEqual([
      ['B'],
      ['C'],
    ]);
    expect(branch.merge?.stage.id).toBe('J');
  });
});
