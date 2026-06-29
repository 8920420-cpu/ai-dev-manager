import test from 'node:test';
import assert from 'node:assert/strict';
import { ReasoningRunner, buildCompletionBody } from '../src/ReasoningRunner.js';
import { classifyAbort } from '../src/claudeReasoningAgent.js';

const silent = { info() {}, warn() {}, error() {} };

function fakeHttp(overrides = {}) {
  const calls = { claim: 0, complete: [], release: [] };
  return {
    calls,
    async claim() {
      calls.claim += 1;
      return overrides.claimReturn ? overrides.claimReturn() : { task: null };
    },
    async complete(body) {
      calls.complete.push(body);
      if (overrides.completeThrows) throw new Error('complete boom');
      return { accepted: true, toStatus: 'DECOMPOSITION', nextRole: 'DECOMPOSER', verdict: 'FORWARD' };
    },
    async release(taskId) {
      calls.release.push(taskId);
      return { released: true };
    },
  };
}

const sampleTask = () => ({ id: 'T1', role: 'ARCHITECT', agentRunId: 'run-1', systemPrompt: 'sys', userPrompt: 'usr' });

const okResult = (extra = {}) => ({
  ok: true, response: '{"outcome":"FORWARD"}', outcome: 'success',
  coldStartMs: 21000, reasonMs: 40000, turns: 7, toolUses: 12,
  tokensIn: 1500, tokensOut: 300, costUsd: 0.042, durationMs: 61000, ...extra,
});

test('idle: нет задачи → ни complete, ни release', async () => {
  const http = fakeHttp();
  const runner = new ReasoningRunner({ http, runAgent: async () => okResult(), log: silent });
  const out = await runner.tick();
  assert.deepEqual(out, { idle: true });
  assert.equal(http.calls.complete.length, 0);
});

test('успех: complete с метриками KPI в теле', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runner = new ReasoningRunner({ http, runAgent: async () => okResult(), log: silent });

  const out = await runner.tick();
  assert.equal(out.success, true);
  assert.equal(http.calls.release.length, 0);
  assert.equal(http.calls.complete.length, 1);

  const body = http.calls.complete[0];
  assert.equal(body.taskId, 'T1');
  assert.equal(body.agentRunId, 'run-1');
  assert.equal(body.tokensIn, 1500);
  assert.equal(body.tokensOut, 300);
  assert.equal(body.costUsd, 0.042);
  assert.equal(body.coldStartMs, 21000);
  assert.equal(body.turns, 7);
  assert.equal(body.outcome, 'success');
  assert.equal(body.durationMs, 61000);
});

test('структурный per-run лог содержит фазы и токены', async () => {
  const logs = [];
  const log = { info: (msg, m) => logs.push({ msg, m }), warn() {}, error() {} };
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runner = new ReasoningRunner({ http, runAgent: async () => okResult(), log });

  await runner.tick();
  const line = logs.find((l) => l.msg === 'reasoning run');
  assert.ok(line, 'должна быть строка "reasoning run"');
  assert.equal(line.m.outcome, 'success');
  assert.equal(line.m.coldStartMs, 21000);
  assert.equal(line.m.reasonMs, 40000);
  assert.equal(line.m.turns, 7);
  assert.equal(line.m.tokensIn, 1500);
  assert.equal(typeof line.m.claimMs, 'number');
  assert.equal(typeof line.m.submitMs, 'number');
  assert.equal(line.m.toStatus, 'DECOMPOSITION');
});

test('провал прогона → release + лог с outcome', async () => {
  const logs = [];
  const log = { info: (msg, m) => logs.push({ msg, m }), warn() {}, error() {} };
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({ ok: false, error: 'agent_aborted', outcome: 'working_slow', coldStartMs: 21000, turns: 3, durationMs: 150000 });
  const runner = new ReasoningRunner({ http, runAgent, log });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'agent_aborted');
  assert.equal(http.calls.complete.length, 0);
  assert.deepEqual(http.calls.release, ['T1']);
  const line = logs.find((l) => l.msg === 'reasoning run');
  assert.equal(line.m.outcome, 'working_slow');
  assert.equal(line.m.reason, 'agent_aborted');
});

test('blocked: гейт оркестратора → ни complete, ни release', async () => {
  const http = fakeHttp({ claimReturn: () => ({ blocked: { taskId: 'T1', missing: ['x'] } }) });
  const runner = new ReasoningRunner({ http, runAgent: async () => okResult(), log: silent });
  const out = await runner.tick();
  assert.ok(out.blocked);
  assert.equal(http.calls.complete.length, 0);
  assert.equal(http.calls.release.length, 0);
});

test('complete упал → release', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }), completeThrows: true });
  const runner = new ReasoningRunner({ http, runAgent: async () => okResult(), log: silent });
  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.match(out.reason, /complete_failed/);
  assert.deepEqual(http.calls.release, ['T1']);
});

test('concurrency=2: два tick параллельно, третий busy', async () => {
  let n = 0;
  const http = fakeHttp({ claimReturn: () => ({ task: { ...sampleTask(), id: `T${++n}` } }) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const runAgent = async () => { await gate; return okResult(); };
  const runner = new ReasoningRunner({ http, runAgent, concurrency: 2, log: silent });

  const a = runner.tick();
  const b = runner.tick();
  const third = await runner.tick();
  assert.deepEqual(third, { busy: true });
  assert.equal(http.calls.claim, 2);

  release();
  await Promise.all([a, b]);
  assert.equal(http.calls.complete.length, 2);
});

test('buildCompletionBody: метрики нормализуются (int/num/null)', () => {
  const task = { id: 'X', agentRunId: 'r', systemPrompt: 's', userPrompt: 'u' };
  const body = buildCompletionBody(task, {
    response: 'txt', durationMs: 1234.7, tokensIn: 10.9, tokensOut: '20', costUsd: 0.01,
    coldStartMs: 21000.4, turns: 5, outcome: 'success',
  });
  assert.equal(body.tokensIn, 11);   // округление
  assert.equal(body.tokensOut, 20);
  assert.equal(body.coldStartMs, 21000);
  assert.equal(body.turns, 5);
  assert.equal(body.costUsd, 0.01);
  assert.equal(body.outcome, 'success');
  assert.equal(body.durationMs, 1234.7);
});

test('buildCompletionBody: отсутствующие метрики → null', () => {
  const body = buildCompletionBody({ id: 'X' }, { response: 'txt' });
  assert.equal(body.tokensIn, null);
  assert.equal(body.tokensOut, null);
  assert.equal(body.costUsd, null);
  assert.equal(body.coldStartMs, null);
  assert.equal(body.turns, null);
  assert.equal(body.outcome, null);
});

test('classifyAbort: различает состояния', () => {
  const now = 1_000_000;
  assert.equal(classifyAbort(null, 0, now, now), 'coldstart_failed');
  assert.equal(classifyAbort(now - 5000, 0, now, now), 'stuck_no_response');
  assert.equal(classifyAbort(now - 50000, 4, now - 1000, now), 'working_slow');
  assert.equal(classifyAbort(now - 200000, 4, now - 120000, now), 'stalled_midway');
});
