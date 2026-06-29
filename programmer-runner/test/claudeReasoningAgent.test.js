import test from 'node:test';
import assert from 'node:assert/strict';
import { makeClaudeReasoningRunAgent, classifyAbort } from '../src/claudeReasoningAgent.js';

// Фейк query() Agent SDK: async-генератор сообщений. Захватывает переданные
// options, чтобы проверить применённый maxTurns.
function fakeQuery(messages, capture = {}) {
  return async function* (args) {
    capture.options = args.options;
    capture.prompt = args.prompt;
    for (const m of messages) yield m;
  };
}

const task = { id: 't1', systemPrompt: 'SYS', userPrompt: 'USR', projectPath: '' };

test('по умолчанию maxTurns=12 (кап разведки)', async () => {
  const capture = {};
  const run = makeClaudeReasoningRunAgent({ query: fakeQuery([
    { type: 'system' },
    { type: 'result', subtype: 'success', result: '{"status":"READY"}', num_turns: 3 },
  ], capture) });
  await run(task, {});
  assert.equal(capture.options.maxTurns, 12);
});

test('успех: turns берётся из result.num_turns, исход success', async () => {
  const run = makeClaudeReasoningRunAgent({ query: fakeQuery([
    { type: 'system' },
    { type: 'assistant', message: { content: [{ type: 'tool_use' }] } },
    { type: 'result', subtype: 'success', result: 'ВЕРДИКТ', num_turns: 7, total_cost_usd: 0.02 },
  ]) });
  const out = await run(task, {});
  assert.equal(out.ok, true);
  assert.equal(out.outcome, 'success');
  assert.equal(out.turns, 7); // num_turns SDK, а не ручной счётчик (=1 assistant)
  assert.equal(out.response, 'ВЕРДИКТ');
});

test('упор в лимит ходов → отдельный исход max_turns_exceeded', async () => {
  const run = makeClaudeReasoningRunAgent({ query: fakeQuery([
    { type: 'system' },
    { type: 'result', subtype: 'error_max_turns', num_turns: 12 },
  ]) });
  const out = await run(task, {});
  assert.equal(out.ok, false);
  assert.equal(out.outcome, 'max_turns_exceeded');
  assert.equal(out.error, 'max_turns_exceeded');
  assert.equal(out.turns, 12);
});

test('classifyAbort: не поднялся / завис / работал — как было', () => {
  assert.equal(classifyAbort(null, 0, 0, 100), 'coldstart_failed');
  assert.equal(classifyAbort(10, 0, 10, 100), 'stuck_no_response');
  assert.equal(classifyAbort(10, 3, 95, 100), 'working_slow');
  assert.equal(classifyAbort(10, 3, 10, 1000000), 'stalled_midway');
});
