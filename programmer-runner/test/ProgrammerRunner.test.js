import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgrammerRunner, buildCompletionBody } from '../src/ProgrammerRunner.js';

const silent = { info() {}, warn() {}, error() {} };

function fakeHttp(overrides = {}) {
  const calls = { claim: 0, complete: [], release: [], releaseArgs: [] };
  return {
    calls,
    async claim() {
      calls.claim += 1;
      return overrides.claimReturn ? overrides.claimReturn() : { task: null };
    },
    async complete(body) {
      calls.complete.push(body);
      if (overrides.completeThrows) throw new Error('complete boom');
      return { accepted: true, duplicate: false, nextRole: 'TASK_REVIEWER' };
    },
    async release(taskId, opts) {
      calls.release.push(taskId);
      calls.releaseArgs.push({ taskId, opts });
      return { released: true };
    },
  };
}

const sampleTask = () => ({
  id: 'T1',
  project: 'PROJECT_2',
  service: 'IAM',
  title: 'IAM-ORG-001',
  completion: {
    completionKey: 'programmer-T1-evt9',
    project: 'PROJECT_2',
    service: 'IAM',
    title: 'IAM-ORG-001',
    sourceDocument: 'tasks/claude-tasks.json',
  },
});

test('idle: нет задачи → ни complete, ни release', async () => {
  const http = fakeHttp();
  const runner = new ProgrammerRunner({ http, runAgent: async () => ({ ok: true }), log: silent });
  const out = await runner.tick();
  assert.deepEqual(out, { idle: true });
  assert.equal(http.calls.complete.length, 0);
  assert.equal(http.calls.release.length, 0);
});

test('успех: runAgent ok → complete с completionKey из задачи, без release', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({ ok: true, changedFiles: ['a.go', 'b_test.go'], result: { summary: 'done' } });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.success, true);
  assert.equal(out.taskId, 'T1');
  assert.equal(http.calls.release.length, 0);
  assert.equal(http.calls.complete.length, 1);

  const body = http.calls.complete[0];
  assert.equal(body.taskId, 'T1');
  assert.equal(body.completionKey, 'programmer-T1-evt9');
  assert.equal(body.project, 'PROJECT_2');
  assert.equal(body.service, 'IAM');
  assert.equal(body.sourceDocument, 'tasks/claude-tasks.json');
  assert.deepEqual(body.changedFiles, ['a.go', 'b_test.go']);
  assert.deepEqual(body.result, { summary: 'done' });
});

test('провал-вердикт: runAgent ok=false → release, без complete', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({ ok: false, error: 'не смог' });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'не смог');
  assert.equal(http.calls.complete.length, 0);
  assert.deepEqual(http.calls.release, ['T1']);
  // Причина обязана уйти оркестратору (иначе в agent_runs остаётся 'released').
  assert.deepEqual(http.calls.releaseArgs[0].opts, { reason: 'не смог' });
});

test('провал-вердикт с meta: reason и meta прокидываются в release', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({ ok: false, error: 'build failed', meta: { numTurns: 7 } });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'build failed');
  assert.deepEqual(http.calls.releaseArgs[0].opts, { reason: 'build failed', meta: { numTurns: 7 } });
});

test('лимит ходов: limitHit → release с reason+meta для KPI', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({
    ok: false, error: 'max_turns_exceeded', limitHit: true, meta: { numTurns: 100, maxTurns: 100 },
  });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.limitHit, true);
  assert.equal(out.reason, 'max_turns_exceeded');
  assert.equal(http.calls.complete.length, 0);
  assert.deepEqual(http.calls.release, ['T1']);
  // Раннер обязан сообщить оркестратору reason+meta — иначе KPI не запишется.
  assert.deepEqual(http.calls.releaseArgs[0].opts, {
    reason: 'max_turns_exceeded', meta: { numTurns: 100, maxTurns: 100 },
  });
});

test('исключение исполнителя → release', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => { throw new Error('crash'); };
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'crash');
  assert.deepEqual(http.calls.release, ['T1']);
  assert.deepEqual(http.calls.releaseArgs[0].opts, { reason: 'crash' });
});

test('таймаут: signal abort → release с reason agent_timeout', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  // Исполнитель «зависает», пока не сработает abort по таймауту.
  const runAgent = (task, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const runner = new ProgrammerRunner({ http, runAgent, taskTimeoutMs: 10, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.equal(out.reason, 'agent_timeout');
  assert.deepEqual(http.calls.release, ['T1']);
  assert.deepEqual(http.calls.releaseArgs[0].opts, { reason: 'agent_timeout' });
});

test('complete упал → release, чтобы не зависнуть в CODING', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }), completeThrows: true });
  const runAgent = async () => ({ ok: true, changedFiles: [], result: {} });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.match(out.reason, /complete_failed/);
  assert.deepEqual(http.calls.release, ['T1']);
  assert.match(http.calls.releaseArgs[0].opts.reason, /complete_failed/);
});

test('реэнтерабельность: пока busy, второй tick не захватывает', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const runAgent = async () => { await gate; return { ok: true, changedFiles: [], result: {} }; };
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });

  const first = runner.tick();
  const second = await runner.tick(); // пока первый держит busy
  assert.deepEqual(second, { busy: true });
  assert.equal(http.calls.claim, 1, 'второй tick не должен звать claim');

  release();
  await first;
  assert.equal(http.calls.complete.length, 1);
});

test('concurrency=2: два tick захватывают параллельно, третий — busy', async () => {
  let n = 0;
  const http = fakeHttp({ claimReturn: () => ({ task: { ...sampleTask(), id: `T${++n}` } }) });
  let release;
  const gate = new Promise((r) => { release = r; });
  const runAgent = async () => { await gate; return { ok: true, changedFiles: [], result: {} }; };
  const runner = new ProgrammerRunner({ http, runAgent, concurrency: 2, log: silent });

  const a = runner.tick();
  const b = runner.tick();
  const third = await runner.tick(); // оба слота заняты
  assert.deepEqual(third, { busy: true });
  assert.equal(http.calls.claim, 2, 'третий tick не должен звать claim');
  assert.equal(runner.availableSlots, 0);

  release();
  await Promise.all([a, b]);
  assert.equal(http.calls.complete.length, 2);
  assert.equal(runner.availableSlots, 2);
});

test('integrate_conflict: ok=false → release (re-queue)', async () => {
  const http = fakeHttp({ claimReturn: () => ({ task: sampleTask() }) });
  const runAgent = async () => ({ ok: false, error: 'integrate_conflict: patch failed', changedFiles: ['x.go'] });
  const runner = new ProgrammerRunner({ http, runAgent, log: silent });
  const out = await runner.tick();
  assert.equal(out.released, true);
  assert.match(out.reason, /integrate_conflict/);
  assert.deepEqual(http.calls.release, ['T1']);
  assert.equal(http.calls.complete.length, 0);
  assert.match(http.calls.releaseArgs[0].opts.reason, /integrate_conflict/);
});

test('buildCompletionBody: фолбэк на поля задачи, changedFiles нормализуется', () => {
  const task = { id: 'X', project: 'PROJECT', service: 'CORE', title: 'T', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, { result: { ok: 1 } });
  assert.equal(body.taskId, 'X');
  assert.equal(body.completionKey, 'k');
  assert.equal(body.project, 'PROJECT');
  assert.equal(body.service, 'CORE');
  assert.equal(body.title, 'T');
  assert.deepEqual(body.changedFiles, []);
  assert.deepEqual(body.result, { ok: 1 });
  assert.equal(body.numTurns, undefined); // нет agent.numTurns → поле не отправляем
});

test('buildCompletionBody: число проходов берётся из result.agent.numTurns', () => {
  const task = { id: 'X', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, { result: { summary: 'ok', agent: { numTurns: 42 } } });
  assert.equal(body.numTurns, 42);
});

// VERSION-KPI-TRACKING-001: метки версии присутствуют в теле сдачи.
test('buildCompletionBody: содержит codeVersion и model (метки версии)', () => {
  const task = { id: 'X', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, { result: {}, model: 'claude-opus-4-8' });
  assert.equal(body.model, 'claude-opus-4-8');
  assert.ok('codeVersion' in body); // git-SHA или null — ключ всегда есть
  // model отсутствует → null, а не undefined (предсказуемо для оркестратора).
  const body2 = buildCompletionBody(task, { result: {} });
  assert.equal(body2.model, null);
});

// PROGRAMMER-USAGE-KPI-001: usage/стоимость/cold start прогона уходят в тело сдачи
// отдельными полями (контракт с оркестратором → agent_runs).
test('buildCompletionBody: usage/cost/coldStart из result.agent → отдельные поля сдачи', () => {
  const task = { id: 'X', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, {
    result: {
      summary: 'ok',
      agent: {
        numTurns: 37,
        tokensIn: 120000,
        tokensOut: 4500,
        tokensCacheRead: 90000,
        tokensCacheCreation: 15000,
        costUsd: 1.23,
        coldStartMs: 21000,
      },
    },
  });
  assert.equal(body.numTurns, 37);
  assert.equal(body.tokensIn, 120000);
  assert.equal(body.tokensOut, 4500);
  assert.equal(body.tokensCacheRead, 90000);
  assert.equal(body.tokensCacheCreation, 15000);
  assert.equal(body.costUsd, 1.23);
  assert.equal(body.coldStartMs, 21000);
});

// costUsd допускается из totalCostUsd (старое поле result.agent), если costUsd нет.
test('buildCompletionBody: costUsd фолбэком из totalCostUsd', () => {
  const task = { id: 'X', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, { result: { agent: { totalCostUsd: 0.77 } } });
  assert.equal(body.costUsd, 0.77);
});

// Обратная совместимость: старый раннер без usage/cold start → поля не выставлены
// (undefined), тело валидно, падения нет.
test('buildCompletionBody: без usage → поля usage/cost/coldStart = undefined (без падения)', () => {
  const task = { id: 'X', completion: { completionKey: 'k' } };
  const body = buildCompletionBody(task, { result: { summary: 'ok' } });
  assert.equal(body.tokensIn, undefined);
  assert.equal(body.tokensOut, undefined);
  assert.equal(body.tokensCacheRead, undefined);
  assert.equal(body.tokensCacheCreation, undefined);
  assert.equal(body.costUsd, undefined);
  assert.equal(body.coldStartMs, undefined);
  // JSON-сериализация выбрасывает undefined-поля → старый формат тела сохраняется.
  const parsed = JSON.parse(JSON.stringify(body));
  assert.ok(!('tokensIn' in parsed));
  assert.ok(!('costUsd' in parsed));
  assert.ok(!('coldStartMs' in parsed));
});
