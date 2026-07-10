import test from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_FLOW, AUTO_ROLE_CODES, nextTransition } from '../src/rolePipeline.js';

test('PROGRAMMER и SCANNER не продвигаются runner-ом (исполняются вне БД)', () => {
  assert.equal(nextTransition('PROGRAMMER'), null);
  assert.equal(nextTransition('SCANNER'), null);
  assert.ok(!AUTO_ROLE_CODES.includes('PROGRAMMER'));
  assert.ok(!AUTO_ROLE_CODES.includes('SCANNER'));
});

test('ARCHITECT → PROGRAMMER (DECOMPOSER-REMOVE-001: декомпозиция убрана)', () => {
  assert.deepEqual(nextTransition('ARCHITECT'), { nextRole: 'PROGRAMMER', toStatus: 'CODING', done: false });
  // DECOMPOSER остаётся off-route фолбэком для легаси-задач под ним.
  assert.deepEqual(nextTransition('DECOMPOSER'), { nextRole: 'PROGRAMMER', toStatus: 'CODING', done: false });
});

test('REVIEW → TESTING → COMMIT-фаза', () => {
  assert.equal(nextTransition('TASK_REVIEWER').toStatus, 'TESTING');
  assert.equal(nextTransition('PIPELINE_SERVICE').toStatus, 'COMMIT');
});

test('GIT_INTEGRATOR завершает маршрут', () => {
  const t = nextTransition('GIT_INTEGRATOR');
  assert.equal(t.done, true);
  assert.equal(t.nextRole, null);
  assert.equal(t.toStatus, 'DONE');
});

test('каждая auto-роль имеет непустой список исходных статусов', () => {
  for (const code of AUTO_ROLE_CODES) {
    assert.ok(Array.isArray(ROLE_FLOW[code].from) && ROLE_FLOW[code].from.length > 0, code);
  }
});

test('неизвестная роль → null', () => {
  assert.equal(nextTransition('NOPE'), null);
});
