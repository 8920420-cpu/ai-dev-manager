import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseClaudeTaskTx } from '../src/db.js';

function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          const out = typeof rule.reply === 'function' ? rule.reply(params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('releaseClaudeTaskTx wraps release writes in one transaction', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks SET assigned_agent_id = NULL/, reply: { rowCount: 1, rows: [{ id: 'T1', current_role_id: 'rP' }] } },
  ]);
  const res = await releaseClaudeTaskTx(c, 'T1', { reason: 'runner_failed' });
  assert.equal(res.released, true);
  assert.equal(c.calls[0].sql, 'BEGIN');
  assert.equal(c.calls.at(-1).sql, 'COMMIT');
});

test('releaseClaudeTaskTx rolls back when a later write fails', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks SET assigned_agent_id = NULL/, reply: { rowCount: 1, rows: [{ id: 'T1', current_role_id: 'rP' }] } },
    { re: /UPDATE agent_runs/, reply: () => { throw new Error('agent_runs down'); } },
  ]);
  await assert.rejects(() => releaseClaudeTaskTx(c, 'T1', { reason: 'runner_failed' }), /agent_runs down/);
  assert.equal(c.calls[0].sql, 'BEGIN');
  assert.equal(c.calls.at(-1).sql, 'ROLLBACK');
});
