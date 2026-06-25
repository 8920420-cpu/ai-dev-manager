import { describe, expect, it } from 'vitest';
import { deriveSchemeEdges } from './deriveEdges';
import type { Stage, StageKind } from '../../types/project';

function node(id: string, kind: StageKind = 'stage'): Stage {
  return { id, kind, stageKey: id, name: id, roleIds: [], enabled: true };
}

describe('deriveSchemeEdges', () => {
  it('линейная схема без fork/join → рёбра не генерируются', () => {
    const { edges } = deriveSchemeEdges([node('a'), node('b'), node('c')]);
    expect(edges).toEqual([]);
  });

  it('гарантирует stageKey для узлов без ключа', () => {
    const { stages } = deriveSchemeEdges([{ id: 's1', name: 'X', roleIds: [], enabled: true }]);
    expect(stages[0]!.stageKey).toBeTruthy();
  });

  it('fork → две ветки → join: backbone + ветви + joinKey', () => {
    const stages = [
      node('A'),
      node('F', 'fork'),
      node('B'),
      node('C'),
      node('J', 'join'),
      node('D'),
    ];
    const { stages: out, edges } = deriveSchemeEdges(stages);

    // joinKey проставлен на fork.
    expect(out.find((s) => s.id === 'F')!.joinKey).toBe('J');

    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);
    expect(pairs).toContain('A->F'); // backbone до fork
    expect(pairs).toContain('F->B'); // ветка 1
    expect(pairs).toContain('F->C'); // ветка 2
    expect(pairs).toContain('B->J'); // ветка 1 → join
    expect(pairs).toContain('C->J'); // ветка 2 → join
    expect(pairs).toContain('J->D'); // backbone после join
    // Нет «сквозного» ребра мимо веток.
    expect(pairs).not.toContain('A->B');
    expect(pairs).not.toContain('B->C');
  });

  it('некорректный fork без join → линейная трактовка (схема не ломается)', () => {
    const { edges } = deriveSchemeEdges([node('A'), node('F', 'fork'), node('B')]);
    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);
    // Без парного join fork ведёт себя как обычный узел в цепочке.
    expect(pairs).toContain('A->F');
    expect(pairs).toContain('F->B');
  });
});
