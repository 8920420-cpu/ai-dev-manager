import test from 'node:test';
import assert from 'node:assert/strict';
import { completeHostTaskTx } from '../src/db.js';

function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          rule.hits = (rule.hits ?? 0) + 1;
          const out = typeof rule.reply === 'function' ? rule.reply(rule.hits, params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

test('GIT_INTEGRATOR fail keeps role owner for doc-serialize gate', async () => {
  const taskId = '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7';
  const c = fakeClient([
    {
      re: /FROM tasks t LEFT JOIN roles r/,
      reply: {
        rowCount: 1,
        rows: [{
          id: taskId,
          status: 'COMMIT',
          current_role_id: 'role-git',
          assigned_agent_id: 'agent-1',
          project_id: 'proj-1',
          current_stage_key: 'stage-git',
          role_code: 'GIT_INTEGRATOR',
        }],
      },
    },
  ]);

  const res = await completeHostTaskTx(c, {
    taskId,
    roleCode: 'GIT_INTEGRATOR',
    success: false,
    output: { note: 'dirty_worktree_conflict', error: 'dirty worktree' },
  });

  assert.equal(res.toStatus, 'BLOCKED');
  assert.equal(res.nextRole, null);

  const upd = c.calls.find((q) => /UPDATE tasks SET status/.test(q.sql));
  assert.ok(upd, 'task updated');
  assert.equal(upd.params[1], 'BLOCKED');
  assert.equal(upd.params[2], 'role-git', 'blocked GI keeps current_role_id for doc claim gate');
  assert.equal(upd.params[4], 'stage-git', 'blocked GI keeps graph stage key');
});
