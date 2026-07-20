// TASK-NEEDS-INPUT-001 — раннер паркует задачу на вопросе вместо холостого requeue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgrammerRunner } from '../src/ProgrammerRunner.js';

const silent = { info() {}, warn() {}, error() {} };

const sampleTask = () => ({
  id: 'T1',
  project: 'PROJECT_2',
  service: 'IAM',
  title: 'IAM-ORG-001',
  completion: { completionKey: 'programmer-T1-evt9' },
});

function fakeHttp({ needsInputThrows = false, withNeedsInput = true } = {}) {
  const calls = { release: [], needsInput: [] };
  const http = {
    calls,
    async claim() { return { task: sampleTask() }; },
    async complete() { return { accepted: true }; },
    async release(taskId, opts) { calls.release.push({ taskId, opts }); return { released: true }; },
  };
  if (withNeedsInput) {
    http.needsInput = async (taskId, input) => {
      calls.needsInput.push({ taskId, input });
      if (needsInputThrows) throw new Error('needs-input boom');
      return { parked: true, taskId, questionId: 'q1' };
    };
  }
  return http;
}

const askingAgent = () => async () => ({
  ok: false,
  error: 'needs_input: Какой БД пользоваться?',
  needsInput: {
    question: 'Какой БД пользоваться для отчётов?',
    options: ['PostgreSQL', 'ClickHouse'],
    context: 'В репозитории есть оба клиента',
  },
});

test('вопрос агента паркует задачу, а не возвращает её в очередь', async () => {
  const http = fakeHttp();
  const runner = new ProgrammerRunner({ http, runAgent: askingAgent(), log: silent });

  const res = await runner.pollOnce();

  assert.equal(res.needsInput, true);
  assert.equal(res.taskId, 'T1');
  assert.equal(http.calls.needsInput.length, 1);
  assert.deepEqual(http.calls.needsInput[0].input, {
    question: 'Какой БД пользоваться для отчётов?',
    options: ['PostgreSQL', 'ClickHouse'],
    context: 'В репозитории есть оба клиента',
  });
  // Ключевое: release НЕ вызывается. Иначе задача вернулась бы в CODING и
  // следующий заход упёрся бы в ту же неоднозначность, сжигая слот.
  assert.equal(http.calls.release.length, 0, 'парковка вместо requeue');
});

test('падение ручки needs-input откатывается на обычный release — задача не виснет с захватом', async () => {
  const http = fakeHttp({ needsInputThrows: true });
  const runner = new ProgrammerRunner({ http, runAgent: askingAgent(), log: silent });

  const res = await runner.pollOnce();

  assert.equal(http.calls.needsInput.length, 1);
  assert.equal(res.released, true);
  assert.equal(http.calls.release.length, 1, 'захват обязан вернуться в пул');
});

test('старый оркестратор без ручки needs-input: обычный release', async () => {
  const http = fakeHttp({ withNeedsInput: false });
  const runner = new ProgrammerRunner({ http, runAgent: askingAgent(), log: silent });

  const res = await runner.pollOnce();

  assert.equal(res.released, true);
  assert.equal(http.calls.release.length, 1);
});

test('обычный провал без вопроса паркой не считается', async () => {
  const http = fakeHttp();
  const runner = new ProgrammerRunner({
    http,
    runAgent: async () => ({ ok: false, error: 'agent_reported_failure: не смог' }),
    log: silent,
  });

  const res = await runner.pollOnce();

  assert.equal(http.calls.needsInput.length, 0);
  assert.equal(res.released, true);
});

test('успешный прогон не трогает ручку вопросов', async () => {
  const http = fakeHttp();
  const runner = new ProgrammerRunner({
    http,
    runAgent: async () => ({ ok: true, changedFiles: ['a.js'], result: { summary: 'ok' } }),
    log: silent,
  });

  const res = await runner.pollOnce();

  assert.equal(res.success, true);
  assert.equal(http.calls.needsInput.length, 0);
});
