import test from 'node:test';
import assert from 'node:assert/strict';
import { completeHostTaskTx } from '../src/db.js';

// Мини-клиент pg: отвечает по первому подходящему правилу (regex по SQL).
// reply может быть функцией (hits, params) → { rows, rowCount }.
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

const TASK = '6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7';
const lookup = /FROM tasks t LEFT JOIN roles r/;

// PROJECT-TASK-HISTORY-001: успешное завершение НИКОГДА не удаляет каноническую
// запись — лишь переводит задачу в DONE и пишет событие TASK_DONE.
test('GIT_INTEGRATOR success → DONE, событие TASK_DONE, без DELETE задачи', async () => {
  const c = fakeClient([
    {
      re: lookup,
      reply: {
        rowCount: 1,
        rows: [{ id: TASK, status: 'COMMIT', current_role_id: 'role-git', assigned_agent_id: 'agent-1', role_code: 'GIT_INTEGRATOR' }],
      },
    },
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'GIT_INTEGRATOR', success: true, output: {} });

  assert.equal(res.accepted, true);
  assert.equal(res.duplicate, false);
  assert.equal(res.toStatus, 'DONE');
  assert.equal(res.nextRole, null);

  const upd = c.calls.find((q) => /UPDATE tasks SET status/.test(q.sql));
  assert.ok(upd, 'задача переведена в новый статус');
  assert.equal(upd.params[1], 'DONE');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.ok(ev, 'записано событие перехода');
  assert.equal(ev.params[1], 'TASK_DONE');
  assert.equal(ev.params[3], 'DONE');

  // Каноническая запись задачи не удаляется ни при каком завершении.
  assert.equal(c.calls.some((q) => /DELETE\s+FROM\s+tasks\b/i.test(q.sql)), false, 'нет DELETE задачи');
  assert.equal(c.calls.some((q) => /COMMIT/.test(q.sql)), true, 'транзакция зафиксирована');
});

// Идемпотентность: повторный completion уже завершённой задачи не пишет событие,
// не меняет историю и не увеличивает «Завершено».
test('повторный completion уже-DONE задачи идемпотентен (duplicate)', async () => {
  const c = fakeClient([
    {
      re: lookup,
      // У терминальной задачи current_role_id = NULL, поэтому role_code = null.
      reply: { rowCount: 1, rows: [{ id: TASK, status: 'DONE', current_role_id: null, assigned_agent_id: null, role_code: null }] },
    },
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'GIT_INTEGRATOR', success: true, output: {} });

  assert.equal(res.accepted, true);
  assert.equal(res.duplicate, true);
  assert.equal(res.toStatus, 'DONE');

  assert.equal(c.calls.some((q) => /UPDATE tasks SET status/.test(q.sql)), false, 'статус не меняется');
  assert.equal(c.calls.some((q) => /INSERT INTO task_events/.test(q.sql)), false, 'новое событие не пишется');
  assert.equal(c.calls.some((q) => /INSERT INTO pipeline_runs/.test(q.sql)), false, 'побочных записей нет');
});

// Та же идемпотентность для CANCELLED/FAILED: жизненный цикл уже завершён.
test('повторный completion CANCELLED/FAILED задачи идемпотентен', async () => {
  for (const status of ['CANCELLED', 'FAILED']) {
    const c = fakeClient([
      { re: lookup, reply: { rowCount: 1, rows: [{ id: TASK, status, current_role_id: null, assigned_agent_id: null, role_code: null }] } },
    ]);
    const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'GIT_INTEGRATOR', success: false, output: {} });
    assert.equal(res.duplicate, true);
    assert.equal(res.toStatus, status);
    assert.equal(c.calls.some((q) => /INSERT INTO task_events/.test(q.sql)), false);
  }
});

test('неизвестная задача → 404 task_not_found', async () => {
  const c = fakeClient([{ re: lookup, reply: { rowCount: 0, rows: [] } }]);
  await assert.rejects(
    () => completeHostTaskTx(c, { taskId: TASK, roleCode: 'GIT_INTEGRATOR', success: true }),
    (e) => e.statusCode === 404 && /task_not_found/.test(e.message),
  );
});

test('активная задача под другой ролью → 409 role_mismatch, без переходов', async () => {
  const c = fakeClient([
    {
      re: lookup,
      reply: { rowCount: 1, rows: [{ id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null, role_code: 'PIPELINE_SERVICE' }] },
    },
  ]);
  await assert.rejects(
    () => completeHostTaskTx(c, { taskId: TASK, roleCode: 'GIT_INTEGRATOR', success: true }),
    (e) => e.statusCode === 409 && /role_mismatch/.test(e.message),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks SET status/.test(q.sql)), false);
  assert.equal(c.calls.some((q) => /ROLLBACK/.test(q.sql)), true, 'транзакция откатана');
});

test('PIPELINE_SERVICE success → pipeline_runs + переход COMMIT (не терминал)', async () => {
  const c = fakeClient([
    {
      re: lookup,
      reply: { rowCount: 1, rows: [{ id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null, role_code: 'PIPELINE_SERVICE' }] },
    },
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'role-da' }] } },
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'PIPELINE_SERVICE', success: true, output: { summary: { ok: true } } });

  assert.equal(res.duplicate, false);
  assert.equal(res.toStatus, 'COMMIT');
  assert.equal(res.nextRole, 'DOCUMENTATION_AUDITOR');
  assert.ok(c.calls.find((q) => /INSERT INTO pipeline_runs/.test(q.sql)), 'записан прогон пайплайна');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'STATUS_CHANGED');
  assert.equal(ev.params[3], 'COMMIT');
});
