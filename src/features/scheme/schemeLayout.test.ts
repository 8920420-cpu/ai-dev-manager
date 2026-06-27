import { describe, expect, it } from 'vitest';
import { buildSchemeLayout } from './schemeLayout';
import { deriveSchemeEdges } from './deriveEdges';
import type { SchemeEdge, Stage, StageKind } from '../../types/project';

function node(id: string, kind: StageKind = 'stage', joinKey?: string): Stage {
  return { id, kind, stageKey: id, joinKey, name: id, roleIds: [], enabled: true };
}

describe('buildSchemeLayout', () => {
  it('без рёбер → чисто линейная раскладка', () => {
    const stages = [node('a'), node('b'), node('c')];
    const layout = buildSchemeLayout(stages, []);
    expect(layout).toHaveLength(3);
    expect(layout.every((i) => i.type === 'node')).toBe(true);
  });

  it('fork→[Auditor→Keeper]‖[Git]→join сворачивается в band с многоузловой веткой', () => {
    // Реальная топология пользователя: одна ветка из двух узлов, другая — из одного.
    const stages = [
      node('FA'),
      node('F', 'fork', 'J'),
      node('DA'), // Documentation Auditor
      node('DK'), // Documentation Keeper
      node('GI'), // Git Integrator
      node('J', 'join'),
      node('END'),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'FA', toKey: 'F' },
      { fromKey: 'F', toKey: 'DA', position: 0 },
      { fromKey: 'F', toKey: 'GI', position: 1 },
      { fromKey: 'DA', toKey: 'DK' },
      { fromKey: 'DK', toKey: 'J' },
      { fromKey: 'GI', toKey: 'J' },
      { fromKey: 'J', toKey: 'END' },
    ];
    const layout = buildSchemeLayout(stages, edges);

    // FA(node) · parallel-band · END(node)
    expect(layout.map((i) => i.type)).toEqual(['node', 'parallel', 'node']);
    const band = layout[1]!;
    if (band.type !== 'parallel') throw new Error('ожидался parallel');
    expect(band.fork.stage.id).toBe('F');
    expect(band.join.stage.id).toBe('J');
    expect(band.branches).toHaveLength(2);
    // Ветка 1 — двухузловая (Auditor → Keeper), ветка 2 — одноузловая (Git).
    expect(band.branches[0]!.map((p) => p.stage.id)).toEqual(['DA', 'DK']);
    expect(band.branches[1]!.map((p) => p.stage.id)).toEqual(['GI']);
  });

  it('совместима с рёбрами из deriveSchemeEdges (одноузловые ветки)', () => {
    const stages = [node('A'), node('F', 'fork'), node('B'), node('C'), node('J', 'join'), node('D')];
    const { stages: out, edges } = deriveSchemeEdges(stages);
    const layout = buildSchemeLayout(out, edges);
    expect(layout.map((i) => i.type)).toEqual(['node', 'parallel', 'node']);
    const band = layout[1]!;
    if (band.type !== 'parallel') throw new Error('ожидался parallel');
    expect(band.branches.map((b) => b.map((p) => p.stage.id))).toEqual([['B'], ['C']]);
  });
});
