import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  nextNodeKey,
  forkBranchKeys,
  outcomeLabel,
  nodeByKey,
} from '../src/graphRoute.js';
import { roleKind } from '../src/rolePipeline.js';

// Граф: A → fork → {B, C} → join → D. Ключи — простые строки для наглядности.
function sampleGraph() {
  const nodes = [
    { stageKey: 'A', kind: 'stage', roleCode: 'ARCHITECT', roleId: 'rA', status: 'ARCHITECTURE' },
    { stageKey: 'F', kind: 'fork', roleCode: 'FORK_GATE', roleId: 'rF', status: null, joinKey: 'J' },
    { stageKey: 'B', kind: 'stage', roleCode: 'PROGRAMMER', roleId: 'rB', status: 'CODING' },
    { stageKey: 'C', kind: 'stage', roleCode: 'TASK_REVIEWER', roleId: 'rC', status: 'REVIEW' },
    { stageKey: 'J', kind: 'join', roleCode: 'JOIN_GATE', roleId: 'rJ', status: null },
    { stageKey: 'D', kind: 'stage', roleCode: 'GIT_INTEGRATOR', roleId: 'rD', status: 'COMMIT' },
  ];
  const edges = [
    { fromKey: 'A', toKey: 'F', position: 0 },
    { fromKey: 'F', toKey: 'B', position: 0 },
    { fromKey: 'F', toKey: 'C', position: 1 },
    { fromKey: 'B', toKey: 'J', position: 0 },
    { fromKey: 'C', toKey: 'J', position: 0 },
    { fromKey: 'J', toKey: 'D', position: 0 },
  ];
  return buildGraph(nodes, edges);
}

test('nextNodeKey: линейный переход по первому ребру', () => {
  const g = sampleGraph();
  assert.equal(nextNodeKey(g, 'A', { outcome: 'FORWARD' }), 'F');
  assert.equal(nextNodeKey(g, 'B', { outcome: 'FORWARD' }), 'J');
  assert.equal(nextNodeKey(g, 'J', { outcome: 'FORWARD' }), 'D');
});

test('nextNodeKey: узел-сток возвращает null (задача завершается)', () => {
  const g = sampleGraph();
  assert.equal(nextNodeKey(g, 'D', { outcome: 'FORWARD' }), null);
});

test('forkBranchKeys: все исходящие ветки fork', () => {
  const g = sampleGraph();
  assert.deepEqual(forkBranchKeys(g, 'F'), ['B', 'C']);
});

test('nodeByKey: возвращает узел и его роль/статус', () => {
  const g = sampleGraph();
  assert.equal(nodeByKey(g, 'B').roleCode, 'PROGRAMMER');
  assert.equal(nodeByKey(g, 'B').status, 'CODING');
  assert.equal(nodeByKey(g, 'zzz'), null);
});

test('condition: выбор ветки по метке исхода (success/failure)', () => {
  const nodes = [
    { stageKey: 'Q', kind: 'condition', roleCode: null, status: null },
    { stageKey: 'OK', kind: 'stage', roleCode: 'GIT_INTEGRATOR', status: 'COMMIT' },
    { stageKey: 'BAD', kind: 'stage', roleCode: 'FAILURE_ANALYST', status: 'FAILURE_ANALYSIS' },
  ];
  const edges = [
    { fromKey: 'Q', toKey: 'OK', condition: 'success', position: 0 },
    { fromKey: 'Q', toKey: 'BAD', condition: 'failure', position: 1 },
  ];
  const g = buildGraph(nodes, edges);
  assert.equal(nextNodeKey(g, 'Q', { outcome: 'FORWARD' }), 'OK');
  assert.equal(nextNodeKey(g, 'Q', { outcome: 'BLOCK' }), 'BAD');
  assert.equal(nextNodeKey(g, 'Q', { outcome: 'REWORK' }), 'BAD');
});

test('outcomeLabel: FORWARD → success; BLOCK/REWORK/BRANCH → failure', () => {
  assert.equal(outcomeLabel({ outcome: 'FORWARD' }), 'success');
  assert.equal(outcomeLabel({ outcome: 'BLOCK' }), 'failure');
  assert.equal(outcomeLabel({ outcome: 'REWORK' }), 'failure');
  assert.equal(outcomeLabel({ outcome: 'BRANCH' }), 'failure');
});

test('gate-роли классифицированы как gate (не analyst — иначе forward их пропустит)', () => {
  assert.equal(roleKind('FORK_GATE'), 'gate');
  assert.equal(roleKind('JOIN_GATE'), 'gate');
});
