// MISSING-OUTPUTS-CAP-001 — кап на петлю «SUCCESS-прогон + недобор обязательных
// выходных полей контракта». Оверрайд missing_outputs в applyReasoningVerdict
// назначает REWORK ПОСЛЕ decideOutcome (мимо max_rework_exceeded), а REWORK первой
// роли маршрута ведёт в неё же саму — до капа задача крутилась вечно (инцидент
// Приёмщика, миграция 0050). Теперь после MAX_REWORK недоборов подряд → BLOCKED.
// Транзакционное ядро сдачи на мини-клиенте pg (первое regex-правило выигрывает),
// по образцу codexReasoning.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { completeReasoningTaskTx, __resetRoleFieldsCacheForTests } from '../src/db.js';

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

// Маршрут проекта: Приёмщик (BACKLOG) → Architect (ARCHITECTURE) — как в инциденте:
// REWORK первой роли резолвится в неё же саму (reworkTarget → firstStep).
function intakeRules({ streakRows }) {
  return [
    { re: /FROM tasks t\s+LEFT JOIN roles r/, reply: { rowCount: 1, rows: [{
      id: 't1', title: 'Телефон +7/7/8', description: '', status: 'BACKLOG', project_id: 'p1',
      data_card: {}, current_stage_key: null, role_code: 'TASK_INTAKE_OFFICER', role_id: 'role-tio',
      agent_run_id: 'run-cur', agent_id: 'a1',
    }] } },
    { re: /FROM role_connectors/, reply: { rowCount: 1, rows: [{ role_code: 'TASK_INTAKE_OFFICER', provider: 'claude_code' }] } },
    { re: /from_status = 'FAILURE_ANALYSIS'/, reply: { rows: [{ n: 0 }] } },
    { re: /INSERT INTO prompt_exchanges/, reply: { rows: [{ id: 'ex1' }] } },
    { re: /FROM project_stages WHERE/, reply: { rowCount: 2, rows: [
      { id: 's0', position: 0, enabled: true, task_status: 'BACKLOG' },
      { id: 's1', position: 1, enabled: true, task_status: 'ARCHITECTURE' },
    ] } },
    { re: /FROM project_stage_roles psr/, reply: { rows: [
      { stage_id: 's0', code: 'TASK_INTAKE_OFFICER', position: 0 },
      { stage_id: 's1', code: 'ARCHITECT', position: 0 },
    ] } },
    { re: /to_regclass/, reply: { rows: [{ t: 'role_fields' }] } },
    { re: /FROM role_fields rf/, reply: { rows: [
      { direction: 'out', required: true, key: 'blocking_questions', name: 'Blocking questions', description: '', value_type: 'list' },
    ] } },
    // Хвост последних завершённых прогонов роли (кап смотрит серию reason).
    { re: /output_json->>'reason'/, reply: { rows: streakRows } },
    { re: /SELECT status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'BACKLOG' }] } },
    { re: /SELECT status::text AS status FROM agent_runs WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'RUNNING' }] } },
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: (hits, params) => ({ rows: [{ id: `role-${params[0]}` }] }) },
  ];
}

// Вердикт READY, но обязательный выход blocking_questions пуст ([]) — недобор:
// isFilled([]) = false (пустой список = «не заполнено» для required-контракта).
const VERDICT = { status: 'READY', summary: 'ok', findings: [], fields: { blocking_questions: [] } };

function findUpdate(calls, re) {
  const q = calls.find((x) => re.test(x.sql));
  assert.ok(q, `нет запроса ${re}`);
  return q;
}

test('missing_outputs без серии повторов → REWORK (SUCCESS) в ту же роль', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(intakeRules({ streakRows: [] }));
  const res = await completeReasoningTaskTx(c, { taskId: 't1', verdict: VERDICT });
  assert.equal(res.accepted, true);
  assert.equal(res.toStatus, 'BACKLOG'); // REWORK первой роли — в неё же саму
  const run = findUpdate(c.calls, /UPDATE agent_runs SET status = \$2/);
  assert.equal(run.params[1], 'SUCCESS');
  const out = JSON.parse(run.params[2]);
  assert.equal(out.reason, 'missing_outputs:blocking_questions');
  assert.equal(out.outcome, 'REWORK');
});

test('missing_outputs: серия прервана другой причиной → кап не срабатывает', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(intakeRules({ streakRows: [
    { reason: 'missing_outputs:blocking_questions' },
    { reason: 'ok' }, // серия прервана — старые недоборы не считаем
    { reason: 'missing_outputs:blocking_questions' },
  ] }));
  const res = await completeReasoningTaskTx(c, { taskId: 't1', verdict: VERDICT });
  assert.equal(res.toStatus, 'BACKLOG');
  const run = findUpdate(c.calls, /UPDATE agent_runs SET status = \$2/);
  assert.equal(run.params[1], 'SUCCESS');
  assert.equal(JSON.parse(run.params[2]).outcome, 'REWORK');
});

test('missing_outputs MAX_REWORK раз подряд → BLOCKED (FAILED) на ручной разбор', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(intakeRules({ streakRows: [
    { reason: 'missing_outputs:blocking_questions' },
    { reason: 'missing_outputs:blocking_questions' },
    { reason: 'missing_outputs:blocking_questions' },
  ] }));
  const res = await completeReasoningTaskTx(c, { taskId: 't1', verdict: VERDICT });
  assert.equal(res.toStatus, 'BLOCKED');
  const run = findUpdate(c.calls, /UPDATE agent_runs SET status = \$2/);
  assert.equal(run.params[1], 'FAILED');
  const out = JSON.parse(run.params[2]);
  assert.equal(out.reason, 'missing_outputs_exceeded');
  assert.equal(out.outcome, 'BLOCK');
  const task = findUpdate(c.calls, /UPDATE tasks SET status = \$2/);
  assert.equal(task.params[1], 'BLOCKED');
});
