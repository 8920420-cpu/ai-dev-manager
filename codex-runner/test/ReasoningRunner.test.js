// Тесты ReasoningRunner: claim → runAgent → complete/release. Без сети и без Codex
// (http и runAgent — подделки), по образцу programmer-runner-тестов.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningRunner, buildCompletionBody } from '../src/ReasoningRunner.js';

const silent = { info() {}, warn() {}, error() {} };
const okTask = { id: 't1', role: 'ARCHITECT', agentRunId: 'run1', systemPrompt: 'S', userPrompt: 'U', outputSchema: {} };

function http(overrides = {}) {
  const calls = { complete: [], release: [] };
  return {
    calls,
    claim: overrides.claim || (async () => ({ task: okTask })),
    complete: overrides.complete || (async (b) => { calls.complete.push(b); return { toStatus: 'ARCHITECTURE', nextRole: 'DECOMPOSER', verdict: 'READY' }; }),
    release: overrides.release || (async (id) => { calls.release.push(id); return { released: true }; }),
  };
}

test('успех: claim → runAgent → complete c verdict', async () => {
  const h = http();
  const runAgent = async () => ({ ok: true, verdict: { status: 'READY', summary: 's', findings: [] }, response: '{}', durationMs: 12 });
  const r = new ReasoningRunner({ http: h, runAgent, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.success, true);
  assert.equal(h.calls.complete.length, 1);
  assert.equal(h.calls.complete[0].taskId, 't1');
  assert.equal(h.calls.complete[0].agentRunId, 'run1');
  assert.deepEqual(h.calls.complete[0].verdict, { status: 'READY', summary: 's', findings: [] });
  assert.equal(h.calls.release.length, 0);
});

test('пустой захват → idle, без вызовов', async () => {
  const h = http({ claim: async () => ({ task: null }) });
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('не должно вызываться'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.idle, true);
});

test('заблокированную входным гейтом задачу пробрасываем как blocked', async () => {
  const h = http({ claim: async () => ({ task: null, blocked: { taskId: 'tX', reason: 'missing_required_inputs' } }) });
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('нет'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.blocked.taskId, 'tX');
});

test('агент не справился → release, без complete', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: false, error: 'codex_failed: x' }), log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.equal(h.calls.release[0], 't1');
  assert.equal(h.calls.complete.length, 0);
});

test('агент бросил → release с причиной', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => { throw new Error('boom'); }, log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'boom');
});

test('сдача упала → release (не зависаем в захвате)', async () => {
  const h = http({ complete: async () => { throw new Error('5xx'); } });
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: true, verdict: { status: 'READY' } }), log: silent });
  const out = await r.pollOnce();
  assert.equal(out.released, true);
  assert.match(out.reason, /complete_failed/);
});

test('busy-гард: нет свободных слотов → busy, без захвата', async () => {
  const h = http();
  const r = new ReasoningRunner({ http: h, runAgent: async () => ({ ok: true }), concurrency: 1, log: silent });
  r.inFlight = 1;
  const out = await r.tick();
  assert.deepEqual(out, { busy: true });
});

test('buildCompletionBody: привязка к захвату + промпт для журнала', () => {
  const body = buildCompletionBody(okTask, { verdict: { status: 'READY' }, response: 'raw', durationMs: 7 });
  assert.equal(body.taskId, 't1');
  assert.equal(body.agentRunId, 'run1');
  assert.equal(body.durationMs, 7);
  assert.match(body.promptText, /S\n\nU/);
});
