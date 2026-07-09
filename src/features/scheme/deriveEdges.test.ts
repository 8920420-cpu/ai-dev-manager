import { describe, expect, it } from 'vitest';
import { deriveSchemeEdges } from './deriveEdges';
import type { Role, Stage, StageKind } from '../../types/project';

function node(id: string, kind: StageKind = 'stage'): Stage {
  return { id, kind, stageKey: id, name: id, roleIds: [], enabled: true };
}

function roleNode(id: string, roleId: string): Stage {
  return { id, kind: 'stage', stageKey: id, name: id, roleIds: [roleId], enabled: true };
}

// Роли документационной ветки и Git Integrator — сопоставление по каноническому коду.
const DOC_ROLES: Role[] = [
  { id: 'rDA', name: 'Documentation Auditor', code: 'DOCUMENTATION_AUDITOR' },
  { id: 'rDK', name: 'Documentation Keeper', code: 'DOCUMENTATION_KEEPER' },
  { id: 'rGI', name: 'Git Integrator', code: 'GIT_INTEGRATOR' },
];

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

  it('документационная ветка Auditor→Keeper — одна последовательная цепочка, Git Integrator параллельно', () => {
    const stages = [
      node('A'),
      node('F', 'fork'),
      roleNode('DA', 'rDA'), // Documentation Auditor
      roleNode('DK', 'rDK'), // Documentation Keeper
      roleNode('GI', 'rGI'), // Git Integrator
      node('J', 'join'),
      node('D'),
    ];
    const { stages: out, edges } = deriveSchemeEdges(stages, DOC_ROLES);
    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);

    expect(out.find((s) => s.id === 'F')!.joinKey).toBe('J');
    expect(pairs).toContain('A->F'); // backbone до fork
    // Ветка документации — последовательная: fork → Auditor → Keeper → join.
    expect(pairs).toContain('F->DA');
    expect(pairs).toContain('DA->DK');
    expect(pairs).toContain('DK->J');
    // Git Integrator — отдельная параллельная ветка.
    expect(pairs).toContain('F->GI');
    expect(pairs).toContain('GI->J');
    expect(pairs).toContain('J->D'); // backbone после join
    // Keeper НЕ параллелен Auditor: нет прямого F→Keeper и нет Auditor→join.
    expect(pairs).not.toContain('F->DK');
    expect(pairs).not.toContain('DA->J');
  });

  it('без справочника ролей документационные узлы остаются отдельными ветками (семейства нет)', () => {
    const stages = [
      node('F', 'fork'),
      roleNode('DA', 'rDA'),
      roleNode('DK', 'rDK'),
      node('J', 'join'),
    ];
    // roles не передан → код роли неизвестен → каждый узел = своя ветка.
    const { edges } = deriveSchemeEdges(stages);
    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);
    expect(pairs).toContain('F->DA');
    expect(pairs).toContain('DA->J');
    expect(pairs).toContain('F->DK');
    expect(pairs).toContain('DK->J');
    expect(pairs).not.toContain('DA->DK');
  });

  it('явный joinKey приоритетнее ближайшего join (выбор парного барьера)', () => {
    // Между fork и его явным join (J2) есть ещё один join (J1) — позиционный
    // резолвер взял бы J1, но выбран J2, поэтому ветка замыкается на J2.
    const fork: Stage = { id: 'F', kind: 'fork', stageKey: 'F', joinKey: 'J2', name: 'F', roleIds: [], enabled: true };
    const stages = [node('A'), fork, node('B'), node('J1', 'join'), node('J2', 'join'), node('D')];
    const { stages: out, edges } = deriveSchemeEdges(stages);
    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);

    expect(out.find((s) => s.id === 'F')!.joinKey).toBe('J2');
    expect(pairs).toContain('A->F');
    expect(pairs).toContain('F->B');
    expect(pairs).toContain('B->J2'); // замыкание на ВЫБРАННЫЙ join, не на ближайший
    expect(pairs).toContain('J2->D');
    expect(pairs).not.toContain('B->J1'); // ближайший join проигнорирован
  });

  it('некорректный fork без join → линейная трактовка (схема не ломается)', () => {
    const { edges } = deriveSchemeEdges([node('A'), node('F', 'fork'), node('B')]);
    const pairs = edges.map((e) => `${e.fromKey}->${e.toKey}`);
    // Без парного join fork ведёт себя как обычный узел в цепочке.
    expect(pairs).toContain('A->F');
    expect(pairs).toContain('F->B');
  });
});
