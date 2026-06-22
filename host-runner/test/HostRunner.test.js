import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRunner } from '../src/HostRunner.js';

const silent = { info() {}, error() {}, warn() {} };

function fakeHttp(overrides = {}) {
  const calls = { claim: [], complete: [], release: [] };
  return {
    calls,
    claim: overrides.claim ?? (async (role) => { calls.claim.push(role); return { task: null }; }),
    complete: overrides.complete ?? (async (b) => { calls.complete.push(b); return { accepted: true }; }),
    release: overrides.release ?? (async (id) => { calls.release.push(id); return { released: true }; }),
  };
}

test('idle: нет задачи => нет complete/release', async () => {
  const http = fakeHttp();
  const runner = new HostRunner({ http, executors: { PIPELINE_SERVICE: async () => ({ success: true }) }, roles: ['PIPELINE_SERVICE'], log: silent });
  const out = await runner.tick();
  assert.deepEqual(out, [{ role: 'PIPELINE_SERVICE', idle: true }]);
  assert.equal(http.calls.complete.length, 0);
});

test('успех: claim -> execute -> complete(success=true) с output', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't1', role: 'PIPELINE_SERVICE' } }) });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: true, output: { runId: 'r1' } }) },
    roles: ['PIPELINE_SERVICE'],
    log: silent,
  });
  const out = await runner.tick();
  assert.deepEqual(out, [{ role: 'PIPELINE_SERVICE', taskId: 't1', success: true }]);
  assert.equal(http.calls.complete.length, 1);
  assert.deepEqual(http.calls.complete[0], { taskId: 't1', role: 'PIPELINE_SERVICE', success: true, output: { runId: 'r1' } });
  assert.equal(http.calls.release.length, 0);
});

test('вердикт-провал: complete(success=false), без release', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't2', role: 'PIPELINE_SERVICE' } }) });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: false, output: { failedStage: 'unit-tests' } }) },
    roles: ['PIPELINE_SERVICE'],
    log: silent,
  });
  await runner.tick();
  assert.equal(http.calls.complete[0].success, false);
  assert.equal(http.calls.release.length, 0);
});

test('сбой исполнителя (throw): release задачи, без complete', async () => {
  const http = fakeHttp({ claim: async () => ({ task: { id: 't3', role: 'GIT_INTEGRATOR' } }) });
  const runner = new HostRunner({
    http,
    executors: { GIT_INTEGRATOR: async () => { throw new Error('git boom'); } },
    roles: ['GIT_INTEGRATOR'],
    log: silent,
  });
  const out = await runner.tick();
  assert.equal(out[0].error, 'git boom');
  assert.equal(http.calls.complete.length, 0);
  assert.deepEqual(http.calls.release, ['t3']);
});

test('обе роли опрашиваются за тик', async () => {
  const seen = [];
  const http = fakeHttp({ claim: async (role) => { seen.push(role); return { task: null }; } });
  const runner = new HostRunner({
    http,
    executors: { PIPELINE_SERVICE: async () => ({ success: true }), GIT_INTEGRATOR: async () => ({ success: true }) },
    log: silent,
  });
  await runner.tick();
  assert.deepEqual(seen, ['PIPELINE_SERVICE', 'GIT_INTEGRATOR']);
});

test('tick не реэнтерабелен', async () => {
  let active = 0;
  let maxActive = 0;
  const http = fakeHttp({
    claim: async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 15)); active -= 1; return { task: null }; },
  });
  const runner = new HostRunner({ http, executors: { PIPELINE_SERVICE: async () => ({ success: true }) }, roles: ['PIPELINE_SERVICE'], log: silent });
  await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
  assert.equal(maxActive, 1);
});
