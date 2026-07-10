import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceWorkStack } from '../src/db.js';

// Мини-клиент pg (как в archServiceSplit.test.js): первое подходящее regex-правило.
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

test('advanceWorkStack: промоутит PENDING в дочернюю CODING-задачу (по одной на свободный сервис)', async () => {
  let childSeq = 0;
  const c = fakeClient([
    { re: /UPDATE work_stack w\s+SET status = CASE/, reply: { rowCount: 0, rows: [] } }, // reconcile: нечего
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /DISTINCT ON \(w.project_id, w.service_id\)/, reply: { rowCount: 2, rows: [
      { id: 'w1', epic_task_id: 'e1', project_id: 'p1', service_id: 'sA', title: 'A', description: 'da', data_card: {}, target_status: 'CODING', target_role_id: 'rProg', target_stage_key: null },
      { id: 'w2', epic_task_id: 'e1', project_id: 'p1', service_id: 'sB', title: 'B', description: 'db', data_card: {}, target_status: 'CODING', target_role_id: null, target_stage_key: null },
    ] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*'work-stack'[\s\S]*RETURNING id/, reply: () => ({ rowCount: 1, rows: [{ id: `child-${++childSeq}` }] }) },
  ]);

  const res = await advanceWorkStack(c);
  assert.equal(res.promoted, 2, 'оба свободных сервиса промоутнуты');
  assert.equal(res.reconciled, 0);

  const childInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'work-stack'/.test(q.sql));
  assert.equal(childInserts.length, 2, 'по одной дочерней задаче на элемент');
  for (const ins of childInserts) {
    assert.ok(['sA', 'sB'].includes(ins.params[1]), 'свой service_id');
    assert.equal(ins.params[2], 'e1', 'parent_task_id = эпик');
    assert.equal(ins.params[5], 'CODING', 'статус входа = target_status');
  }
  // Элемент w2 без target_role_id → падаем на PROGRAMMER-роль.
  const insB = childInserts.find((q) => q.params[1] === 'sB');
  assert.equal(insB.params[6], 'rProg', 'target_role_id=null → роль Программиста по умолчанию');

  const deps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql));
  assert.equal(deps.length, 2, 'эпик зависит от каждой дочерней (единица приёмки)');

  const promotes = c.calls.filter((q) => /UPDATE work_stack SET status = 'PROMOTED'/.test(q.sql));
  assert.equal(promotes.length, 2, 'элементы помечены PROMOTED со ссылкой на дочернюю задачу');

  const events = c.calls.filter((q) => /INSERT INTO task_events/.test(q.sql) && /work_stack_promote/.test(String(q.params?.[3] ?? '')));
  assert.equal(events.length, 2, 'TASK_CREATED с reason=work_stack_promote');

  // Замок сервиса зашит в выборку PENDING.
  const pick = c.calls.find((q) => /DISTINCT ON \(w.project_id, w.service_id\)/.test(q.sql));
  assert.match(pick.sql, /status = 'PROMOTED'/, 'исключаем сервисы с активным PROMOTED-элементом');
  assert.match(pick.sql, /t2.status NOT IN \('DONE','CANCELLED','FAILED'\)/, 'исключаем сервисы с незавершённой дочерней задачей');

  // Всё под транзакцией и advisory-локом промоутера.
  assert.ok(c.calls.some((q) => /pg_advisory_xact_lock/.test(q.sql)), 'взят advisory-лок промоутера');
  assert.ok(c.calls.some((q) => q.sql === 'COMMIT'), 'зафиксировано COMMIT');
});

test('advanceWorkStack: reconcile переводит PROMOTED с терминальной дочерней задачей в терминал', async () => {
  const c = fakeClient([
    { re: /UPDATE work_stack w\s+SET status = CASE/, reply: { rowCount: 3, rows: [] } }, // 3 элемента сведены
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /DISTINCT ON \(w.project_id, w.service_id\)/, reply: { rowCount: 0, rows: [] } }, // промоутить нечего
  ]);
  const res = await advanceWorkStack(c);
  assert.equal(res.reconciled, 3, 'reconcile вернул число сведённых элементов');
  assert.equal(res.promoted, 0);
  const rec = c.calls.find((q) => /UPDATE work_stack w\s+SET status = CASE/.test(q.sql));
  assert.match(rec.sql, /WHEN 'DONE' THEN 'DONE'/);
  assert.match(rec.sql, /WHEN 'CANCELLED' THEN 'CANCELLED'/);
  assert.match(rec.sql, /ELSE 'FAILED'/, 'BLOCKED/FAILED дочерней задачи → FAILED элемент (освобождает замок сервиса)');
  assert.match(rec.sql, /t.status IN \('DONE','CANCELLED','FAILED','BLOCKED'\)/, 'сводим только по терминальной дочерней задаче');
});

test('advanceWorkStack: пустой стек → ничего не делает, но транзакция открывается/закрывается', async () => {
  const c = fakeClient([
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
  ]);
  const res = await advanceWorkStack(c);
  assert.deepEqual(res, { reconciled: 0, promoted: 0 });
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false, 'детей не создаём');
  assert.ok(c.calls.some((q) => q.sql === 'COMMIT'));
});
