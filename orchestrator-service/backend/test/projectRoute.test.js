import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoute,
  routeIsUsable,
  firstStep,
  forwardFrom,
  findEnabled,
  reworkTarget,
  resolveTransition,
  canonicalForward,
} from '../src/projectRoute.js';
import { decideOutcome } from '../src/roleEngine.js';

// Эталонный маршрут проекта (порядок этапов задаёт переходы).
function sampleStages() {
  return [
    { position: 0, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
    { position: 1, enabled: true, taskStatus: 'REVIEW', roleCodes: ['TASK_REVIEWER'] },
    { position: 2, enabled: true, taskStatus: 'FAILURE_ANALYSIS', roleCodes: ['FAILURE_ANALYST'] },
    { position: 3, enabled: true, taskStatus: 'TESTING', roleCodes: ['PIPELINE_SERVICE'] },
    { position: 4, enabled: true, taskStatus: 'COMMIT', roleCodes: ['DOCUMENTATION_AUDITOR'] },
    { position: 5, enabled: true, taskStatus: 'COMMIT', roleCodes: ['DOCUMENTATION_KEEPER'] },
    { position: 6, enabled: true, taskStatus: 'COMMIT', roleCodes: ['GIT_INTEGRATOR'] },
  ];
}

test('buildRoute: плоский порядок этап×роль, статус и enabled на месте', () => {
  const route = buildRoute([
    { position: 1, enabled: true, taskStatus: 'REVIEW', roleCodes: ['TASK_REVIEWER'] },
    { position: 0, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER', 'SCANNER'] },
  ]);
  // Сортировка по position: сначала CODING-этап (2 роли), затем REVIEW.
  assert.deepEqual(route.map((e) => e.roleCode), ['PROGRAMMER', 'SCANNER', 'TASK_REVIEWER']);
  assert.equal(route[0].status, 'CODING');
  assert.equal(route[2].status, 'REVIEW');
  assert.ok(route.every((e) => e.stageEnabled));
});

test('buildRoute: scanner.taskStatus как фолбэк статуса этапа', () => {
  const route = buildRoute([{ position: 0, enabled: true, scanner: { taskStatus: 'coding' }, roleCodes: ['SCANNER'] }]);
  assert.equal(route[0].status, 'CODING');
});

test('routeIsUsable: нужен включённый этап со статусом', () => {
  assert.equal(routeIsUsable([]), false);
  assert.equal(routeIsUsable(buildRoute([{ position: 0, enabled: false, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] }])), false);
  assert.equal(routeIsUsable(buildRoute([{ position: 0, enabled: true, taskStatus: null, roleCodes: ['PROGRAMMER'] }])), false);
  assert.equal(routeIsUsable(buildRoute(sampleStages())), true);
});

test('firstStep: первая включённая роль со статусом', () => {
  const route = buildRoute([
    { position: 0, enabled: false, taskStatus: 'CODING', roleCodes: ['STRUCTURE_KEEPER'] },
    { position: 1, enabled: true, taskStatus: 'ARCHITECTURE', roleCodes: ['ARCHITECT'] },
  ]);
  assert.equal(firstStep(route).roleCode, 'ARCHITECT');
});

test('forwardFrom: следующая включённая роль; null в конце; undefined если роли нет', () => {
  const route = buildRoute(sampleStages());
  assert.equal(forwardFrom(route, 'PROGRAMMER').roleCode, 'TASK_REVIEWER');
  assert.equal(forwardFrom(route, 'GIT_INTEGRATOR'), null);
  assert.equal(forwardFrom(route, 'NO_SUCH_ROLE'), undefined);
});

test('forwardFrom: пропускает отключённый этап', () => {
  const route = buildRoute([
    { position: 0, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
    { position: 1, enabled: false, taskStatus: 'REVIEW', roleCodes: ['TASK_REVIEWER'] },
    { position: 2, enabled: true, taskStatus: 'TESTING', roleCodes: ['PIPELINE_SERVICE'] },
  ]);
  assert.equal(forwardFrom(route, 'PROGRAMMER').roleCode, 'PIPELINE_SERVICE');
});

test('forwardFrom: пропускает роль-аналитика (branch-цель, не линейный шаг)', () => {
  // FAILURE_ANALYST стоит линейным этапом между Pipeline и аудитором. УСПЕШНЫЙ
  // pipeline (FORWARD) должен перешагнуть аналитика на Documentation Auditor,
  // иначе задача зациклится Pipeline→Analyst→Programmer.
  const route = buildRoute([
    { position: 0, enabled: true, taskStatus: 'TESTING', roleCodes: ['PIPELINE_SERVICE'] },
    { position: 1, enabled: true, taskStatus: 'FAILURE_ANALYSIS', roleCodes: ['FAILURE_ANALYST'] },
    { position: 2, enabled: true, taskStatus: 'COMMIT', roleCodes: ['DOCUMENTATION_AUDITOR'] },
  ]);
  assert.equal(forwardFrom(route, 'PIPELINE_SERVICE').roleCode, 'DOCUMENTATION_AUDITOR');
  // А ревью (APPROVED→FORWARD) тоже перешагивает аналитика на Pipeline в эталоне.
  const full = buildRoute(sampleStages());
  assert.equal(forwardFrom(full, 'TASK_REVIEWER').roleCode, 'PIPELINE_SERVICE');
});

test('resolveTransition FORWARD после Pipeline → аудитор (через аналитика-этап)', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'PIPELINE_SERVICE', { outcome: 'FORWARD' });
  assert.deepEqual([r.nextRole, r.toStatus], ['DOCUMENTATION_AUDITOR', 'COMMIT']);
});

test('resolveTransition BRANCH к аналитику работает, хотя forward его пропускает', () => {
  // Аналитик остаётся достижим на ПРОВАЛЕ pipeline (BRANCH по типу), несмотря на
  // то, что FORWARD его пропускает.
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'PIPELINE_SERVICE', {
    outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework',
  });
  assert.deepEqual([r.nextRole, r.toStatus], ['FAILURE_ANALYST', 'FAILURE_ANALYSIS']);
});

test('reworkTarget: ближайший предшествующий исполнитель', () => {
  const route = buildRoute(sampleStages());
  assert.equal(reworkTarget(route, 'FAILURE_ANALYST').roleCode, 'PROGRAMMER');
  assert.equal(reworkTarget(route, 'TASK_REVIEWER').roleCode, 'PROGRAMMER');
});

test('resolveTransition FORWARD: следующая роль маршрута', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'PROGRAMMER', { outcome: 'FORWARD' });
  assert.deepEqual([r.nextRole, r.toStatus, r.done], ['TASK_REVIEWER', 'REVIEW', false]);
});

test('resolveTransition FORWARD в конце → DONE', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'GIT_INTEGRATOR', { outcome: 'FORWARD' });
  assert.equal(r.done, true);
  assert.equal(r.toStatus, 'DONE');
});

test('resolveTransition BRANCH к аналитику по типу', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'TASK_REVIEWER', { outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework' });
  assert.deepEqual([r.nextRole, r.toStatus], ['FAILURE_ANALYST', 'FAILURE_ANALYSIS']);
});

test('resolveTransition BRANCH без ветки + fallback rework → к исполнителю', () => {
  // Маршрут БЕЗ аналитика: провал гейта уходит на доработку исполнителю, не вперёд.
  const route = buildRoute([
    { position: 0, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
    { position: 1, enabled: true, taskStatus: 'REVIEW', roleCodes: ['TASK_REVIEWER'] },
    { position: 2, enabled: true, taskStatus: 'COMMIT', roleCodes: ['GIT_INTEGRATOR'] },
  ]);
  const r = resolveTransition(route, 'TASK_REVIEWER', { outcome: 'BRANCH', branchKind: 'analyst', branchRole: 'FAILURE_ANALYST', branchFallback: 'rework' });
  assert.deepEqual([r.nextRole, r.toStatus], ['PROGRAMMER', 'CODING']);
});

test('resolveTransition REWORK → ближайший исполнитель', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'FAILURE_ANALYST', { outcome: 'REWORK' });
  assert.deepEqual([r.nextRole, r.toStatus], ['PROGRAMMER', 'CODING']);
});

test('resolveTransition BLOCK', () => {
  const route = buildRoute(sampleStages());
  const r = resolveTransition(route, 'ARCHITECT', { outcome: 'BLOCK', blockStatus: 'BLOCKED' });
  assert.equal(r.blocked, true);
  assert.equal(r.toStatus, 'BLOCKED');
});

test('resolveTransition: пустой маршрут → канонический фолбэк ROLE_FLOW', () => {
  const r = resolveTransition([], 'ARCHITECT', { outcome: 'FORWARD' });
  assert.equal(r.via, 'canonical');
  assert.deepEqual([r.nextRole, r.toStatus], ['PROGRAMMER', 'CODING']);
});

test('canonicalForward: из ROLE_FLOW', () => {
  assert.deepEqual(canonicalForward('GIT_INTEGRATOR'), { nextRole: null, toStatus: 'DONE', done: true, blocked: false });
});

test('findEnabled: по коду роли', () => {
  const route = buildRoute(sampleStages());
  assert.equal(findEnabled(route, 'DOCUMENTATION_KEEPER').status, 'COMMIT');
  assert.equal(findEnabled(route, 'NOPE'), null);
});

// --- Интеграция decideOutcome + resolveTransition ---------------------------

test('TASK_REVIEWER APPROVED → вперёд на Pipeline (аналитик-этап пропускается)', () => {
  const route = buildRoute(sampleStages());
  const d = decideOutcome('TASK_REVIEWER', { ok: true, status: 'APPROVED' });
  const r = resolveTransition(route, 'TASK_REVIEWER', d);
  // FORWARD перешагивает линейный этап-аналитик (branch-цель) на PIPELINE_SERVICE.
  assert.equal(r.nextRole, 'PIPELINE_SERVICE');
  assert.equal(r.toStatus, 'TESTING');
  assert.equal(d.outcome, 'FORWARD');
});

test('TASK_REVIEWER NEEDS_FIX → BRANCH к аналитику', () => {
  const route = buildRoute(sampleStages());
  const d = decideOutcome('TASK_REVIEWER', { ok: false, status: 'NEEDS_FIX' }, { reworkCount: 0 });
  assert.equal(d.outcome, 'BRANCH');
  const r = resolveTransition(route, 'TASK_REVIEWER', d);
  assert.equal(r.nextRole, 'FAILURE_ANALYST');
});

test('FAILURE_ANALYST DIAGNOSED → REWORK к исполнителю', () => {
  const route = buildRoute(sampleStages());
  const d = decideOutcome('FAILURE_ANALYST', { ok: true, status: 'DIAGNOSED' });
  assert.equal(d.outcome, 'REWORK');
  const r = resolveTransition(route, 'FAILURE_ANALYST', d);
  assert.equal(r.nextRole, 'PROGRAMMER');
});

test('FAILURE_ANALYST INFRASTRUCTURE_BLOCKED → BLOCK', () => {
  const d = decideOutcome('FAILURE_ANALYST', { ok: false, status: 'INFRASTRUCTURE_BLOCKED' });
  assert.equal(d.outcome, 'BLOCK');
});

test('DOCUMENTATION_AUDITOR UPDATE_REQUIRED → BRANCH к keeper', () => {
  const route = buildRoute(sampleStages());
  const d = decideOutcome('DOCUMENTATION_AUDITOR', { status: 'UPDATE_REQUIRED' });
  assert.equal(d.outcome, 'BRANCH');
  const r = resolveTransition(route, 'DOCUMENTATION_AUDITOR', d);
  assert.equal(r.nextRole, 'DOCUMENTATION_KEEPER');
});

test('decideOutcome max_rework → BLOCK', () => {
  const d = decideOutcome('TASK_REVIEWER', { ok: false, status: 'NEEDS_FIX' }, { reworkCount: 3, maxRework: 3 });
  assert.equal(d.outcome, 'BLOCK');
  assert.equal(d.reason, 'max_rework_exceeded');
});
