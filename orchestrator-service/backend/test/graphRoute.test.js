import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  nextNodeKey,
  forkBranchKeys,
  outcomeLabel,
  nodeByKey,
  reworkNodeKey,
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

// FORWARD-NO-ANALYST-001 — маршрут проекта «Оркестратор»: Pipeline Service стоит
// по позиции перед Failure Analyst и Fork (рёбра сгенерированы линейно, БЕЗ меток
// условий). Успех Pipeline Service должен минуть аналитика и уйти в fork; провал —
// привести к аналитику. FORWARD НИКОГДА не приземляется на узел разбора провала.
function pipelineForkGraph() {
  const nodes = [
    { stageKey: 'PS', kind: 'stage', roleCode: 'PIPELINE_SERVICE', status: 'TESTING' },
    { stageKey: 'FA', kind: 'stage', roleCode: 'FAILURE_ANALYST', status: 'FAILURE_ANALYSIS' },
    { stageKey: 'FORK', kind: 'fork', roleCode: 'FORK_GATE', status: null, joinKey: 'JOIN' },
    { stageKey: 'B', kind: 'stage', roleCode: 'DOCUMENTATION_AUDITOR', status: 'COMMIT' },
    { stageKey: 'JOIN', kind: 'join', roleCode: 'JOIN_GATE', status: null },
  ];
  const edges = [
    { fromKey: 'PS', toKey: 'FA', condition: null, position: 0 },
    { fromKey: 'FA', toKey: 'FORK', condition: null, position: 0 },
    { fromKey: 'FORK', toKey: 'B', condition: null, position: 0 },
    { fromKey: 'B', toKey: 'JOIN', condition: null, position: 0 },
  ];
  return buildGraph(nodes, edges);
}

test('FORWARD успеха Pipeline Service минует аналитика и уходит в fork', () => {
  const g = pipelineForkGraph();
  assert.equal(nextNodeKey(g, 'PS', { outcome: 'FORWARD' }), 'FORK', 'зелёный путь → fork, не Failure Analyst');
});

test('провал Pipeline Service (BRANCH/BLOCK) ведёт к аналитику', () => {
  const g = pipelineForkGraph();
  assert.equal(nextNodeKey(g, 'PS', { outcome: 'BRANCH' }), 'FA', 'провал → Failure Analyst');
  assert.equal(nextNodeKey(g, 'PS', { outcome: 'BLOCK' }), 'FA', 'блок → Failure Analyst');
});

test('nextNodeKey: узел-исполнитель с рёбрами-условиями ветвится по исходу (не kind=condition)', () => {
  const nodes = [
    { stageKey: 'PS', kind: 'stage', roleCode: 'PIPELINE_SERVICE', status: 'TESTING' },
    { stageKey: 'FORK', kind: 'fork', roleCode: 'FORK_GATE', status: null },
    { stageKey: 'FA', kind: 'stage', roleCode: 'FAILURE_ANALYST', status: 'FAILURE_ANALYSIS' },
  ];
  const edges = [
    { fromKey: 'PS', toKey: 'FORK', condition: 'success', position: 0 },
    { fromKey: 'PS', toKey: 'FA', condition: 'failure', position: 1 },
  ];
  const g = buildGraph(nodes, edges);
  assert.equal(nextNodeKey(g, 'PS', { outcome: 'FORWARD' }), 'FORK', 'success-ребро → fork');
  assert.equal(nextNodeKey(g, 'PS', { outcome: 'BRANCH' }), 'FA', 'failure-ребро → analyst');
});

test('reworkNodeKey: доработка от аналитика → назад к ближайшему исполнителю', () => {
  const nodes = [
    { stageKey: 'ARCH', kind: 'stage', roleCode: 'ARCHITECT', status: 'ARCHITECTURE' },
    { stageKey: 'PROG', kind: 'stage', roleCode: 'PROGRAMMER', status: 'CODING' },
    { stageKey: 'REV', kind: 'stage', roleCode: 'TASK_REVIEWER', status: 'REVIEW' },
    { stageKey: 'PS', kind: 'stage', roleCode: 'PIPELINE_SERVICE', status: 'TESTING' },
    { stageKey: 'FA', kind: 'stage', roleCode: 'FAILURE_ANALYST', status: 'FAILURE_ANALYSIS' },
  ];
  const edges = [
    { fromKey: 'ARCH', toKey: 'PROG', condition: null, position: 0 },
    { fromKey: 'PROG', toKey: 'REV', condition: null, position: 0 },
    { fromKey: 'REV', toKey: 'PS', condition: null, position: 0 },
    { fromKey: 'PS', toKey: 'FA', condition: null, position: 0 },
  ];
  const g = buildGraph(nodes, edges);
  assert.equal(reworkNodeKey(g, 'FA'), 'PROG', 'ближайший предшествующий исполнитель — Программист');
  assert.equal(reworkNodeKey(g, 'PROG'), 'ARCH', 'без исполнителя выше — проектная роль (design)');
});
