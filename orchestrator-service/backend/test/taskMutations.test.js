// TASK-MANUAL-MOVE-001 — тесты UI-мутаций продвижения/перемещения задачи.
// Мини-клиент pg (как в forkJoin.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceTaskTx, moveTaskTx } from '../src/db.js';

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

// Линейный маршрут проекта: ARCHITECT(ARCHITECTURE) → PROGRAMMER(CODING) → TASK_REVIEWER(REVIEW).
const STAGE_ROWS = [
  { id: 's1', position: 0, enabled: true, task_status: 'ARCHITECTURE' },
  { id: 's2', position: 1, enabled: true, task_status: 'CODING' },
  { id: 's3', position: 2, enabled: true, task_status: 'REVIEW' },
];
const STAGE_ROLE_ROWS = [
  { stage_id: 's1', code: 'ARCHITECT', position: 0 },
  { stage_id: 's2', code: 'PROGRAMMER', position: 0 },
  { stage_id: 's3', code: 'TASK_REVIEWER', position: 0 },
];

const routeRules = () => [
  { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: 3, rows: STAGE_ROWS } },
  { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: 3, rows: STAGE_ROLE_ROWS } },
  { re: /SELECT id FROM roles WHERE code = \$1/, reply: (_h, p) => ({
      rowCount: 1, rows: [{ id: p[0] === 'TASK_REVIEWER' ? 'rRev' : `r-${p[0]}` }],
    }) },
];

// --- advanceTask: успешное продвижение по маршруту ---------------------------

test('advanceTask: PROGRAMMER/CODING → следующий этап TASK_REVIEWER/REVIEW + событие', async () => {
  const c = fakeClient([
    { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: {
      rowCount: 1,
      rows: [{ id: 't1', project_id: 'p1', status: 'CODING', current_role_id: 'rP', current_stage_key: null, role_code: 'PROGRAMMER' }],
    } },
    ...routeRules(),
  ]);

  const res = await advanceTaskTx(c, 't1');
  assert.equal(res.advanced, true);
  assert.equal(res.fromStatus, 'CODING');
  assert.equal(res.toStatus, 'REVIEW');
  assert.equal(res.nextRole, 'TASK_REVIEWER');

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd, 'задача обновлена');
  assert.equal(upd.params[1], 'REVIEW');
  assert.equal(upd.params[2], 'rRev', 'роль следующего этапа');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.ok(ev, 'записано событие');
  assert.equal(ev.params[1], 'CODING'); // from_status ($2)
  assert.equal(ev.params[2], 'REVIEW'); // to_status ($3)
  assert.equal(ev.params[3], 'rRev'); // role_id ($4)
  const payload = JSON.parse(ev.params[4]); // payload_json ($5)
  assert.equal(payload.source, 'manual-advance');
  assert.equal(payload.nextRole, 'TASK_REVIEWER');
  // Аудит-поля по спецификации: fromStatus/toStatus/targetStage в payload.
  assert.equal(payload.fromStatus, 'CODING');
  assert.equal(payload.toStatus, 'REVIEW');
  // Позиционный маршрут (current_stage_key=null) → targetStage деградирует до кода роли.
  assert.equal(payload.targetStage, 'TASK_REVIEWER');

  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)), 'транзакция зафиксирована');
});

test('advanceTask: последний этап маршрута → DONE (done=true, роль NULL)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: {
      rowCount: 1,
      rows: [{ id: 't1', project_id: 'p1', status: 'REVIEW', current_role_id: 'rRev', current_stage_key: null, role_code: 'TASK_REVIEWER' }],
    } },
    ...routeRules(),
  ]);

  const res = await advanceTaskTx(c, 't1');
  assert.equal(res.done, true);
  assert.equal(res.toStatus, 'DONE');
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'DONE');
  assert.equal(upd.params[2], null, 'за концом маршрута роли нет');
});

// --- advanceTask: запрет некорректного перехода -----------------------------

for (const status of ['DONE', 'CANCELLED', 'FAILED']) {
  test(`advanceTask: терминальная задача (${status}) → 409 task_terminal, без UPDATE`, async () => {
    const c = fakeClient([
      { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: {
        rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status, current_role_id: null, current_stage_key: null, role_code: null }],
      } },
    ]);
    await assert.rejects(() => advanceTaskTx(c, 't1'), (e) => e.statusCode === 409 && /terminal/.test(e.message));
    assert.equal(c.calls.some((q) => /UPDATE tasks SET status/.test(q.sql)), false, 'задача не двигается');
    assert.ok(c.calls.some((q) => /ROLLBACK/.test(q.sql)), 'откат транзакции');
  });
}

test('advanceTask: BLOCKED → 409 task_blocked_use_manual (нужно ручное перемещение)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'BLOCKED', current_role_id: 'rP', current_stage_key: null, role_code: 'PROGRAMMER' }],
    } },
  ]);
  await assert.rejects(() => advanceTaskTx(c, 't1'), (e) => e.statusCode === 409 && /manual/.test(e.message));
});

test('advanceTask: захваченная задача (assigned_agent_id != NULL) → 409 task_assigned_use_manual, без UPDATE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'CODING', current_role_id: 'rP', current_stage_key: null, assigned_agent_id: 'agent-7', role_code: 'PROGRAMMER' }],
    } },
    ...routeRules(),
  ]);
  await assert.rejects(
    () => advanceTaskTx(c, 't1'),
    (e) => e.statusCode === 409 && /task_assigned_use_manual/.test(e.message),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks SET status/.test(q.sql)), false, 'захваченную задачу авто-продвижение не двигает');
  assert.ok(c.calls.some((q) => /ROLLBACK/.test(q.sql)), 'откат транзакции');
});

test('advanceTask: несуществующая задача → 404 task_not_found', async () => {
  const c = fakeClient([
    { re: /FROM tasks t LEFT JOIN roles r[\s\S]*FOR UPDATE OF t/, reply: { rowCount: 0, rows: [] } },
  ]);
  await assert.rejects(() => advanceTaskTx(c, 'nope'), (e) => e.statusCode === 404);
});

// --- moveTask: ручное перемещение с аудитом ---------------------------------

test('moveTask: BLOCKED → выбранный этап CODING, событие source=manual с причиной', async () => {
  const c = fakeClient([
    { re: /SELECT id, project_id, status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'BLOCKED' }],
    } },
    { re: /FROM project_stages ps\s+WHERE ps.id = \$1 AND ps.project_id = \$2/, reply: {
      rowCount: 1, rows: [{ stage_key: 'k2', kind: 'stage', task_status: 'CODING', name: 'Programmer', role_id: 'rP' }],
    } },
  ]);

  const res = await moveTaskTx(c, 't1', { toStageId: 's2', reason: 'разблокировка вручную' });
  assert.equal(res.moved, true);
  assert.equal(res.fromStatus, 'BLOCKED');
  assert.equal(res.toStatus, 'CODING');

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'CODING');
  assert.equal(upd.params[2], 'rP');
  assert.equal(upd.params[3], 'k2', 'current_stage_key целевого этапа');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  const payload = JSON.parse(ev.params[4]); // payload_json ($5)
  assert.equal(payload.source, 'manual');
  assert.equal(payload.fromStatus, 'BLOCKED');
  assert.equal(payload.toStatus, 'CODING');
  assert.equal(payload.reason, 'разблокировка вручную');
  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)));
});

test('moveTask: целевой этап не из проекта задачи → 404 target_stage_not_found', async () => {
  const c = fakeClient([
    { re: /SELECT id, project_id, status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'BLOCKED' }],
    } },
    { re: /FROM project_stages ps\s+WHERE ps.id = \$1 AND ps.project_id = \$2/, reply: { rowCount: 0, rows: [] } },
  ]);
  await assert.rejects(() => moveTaskTx(c, 't1', { toStageId: 'alien', reason: 'нужно' }), (e) => e.statusCode === 404 && /target_stage_not_found/.test(e.message));
});

test('moveTask: без toStageId → 422 target_stage_required', async () => {
  const c = fakeClient([]);
  await assert.rejects(() => moveTaskTx(c, 't1', {}), (e) => e.statusCode === 422 && /target_stage_required/.test(e.message));
});

test('moveTask: контрольный узел без статуса (fork/join) → 422 target_stage_no_status', async () => {
  const c = fakeClient([
    { re: /SELECT id, project_id, status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'CODING' }],
    } },
    { re: /FROM project_stages ps\s+WHERE ps.id = \$1 AND ps.project_id = \$2/, reply: {
      rowCount: 1, rows: [{ stage_key: 'kf', kind: 'fork', task_status: null, name: 'Fork', role_id: 'rFork' }],
    } },
  ]);
  await assert.rejects(() => moveTaskTx(c, 't1', { toStageId: 'sf', reason: 'нужно' }), (e) => e.statusCode === 422 && /no_status/.test(e.message));
});

// --- moveTask: причина обязательна ------------------------------------------

test('moveTask: без reason → 422 reason_required (audit без причины запрещён)', async () => {
  const c = fakeClient([
    { re: /SELECT id, project_id, status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: {
      rowCount: 1, rows: [{ id: 't1', project_id: 'p1', status: 'BLOCKED' }],
    } },
  ]);
  await assert.rejects(
    () => moveTaskTx(c, 't1', { toStageId: 's2' }),
    (e) => e.statusCode === 422 && /reason_required/.test(e.message),
  );
  // Пустая строка/пробелы тоже не проходят и задачу не двигают.
  await assert.rejects(
    () => moveTaskTx(c, 't1', { toStageId: 's2', reason: '   ' }),
    (e) => e.statusCode === 422 && /reason_required/.test(e.message),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks SET status/.test(q.sql)), false, 'задача не двигается без причины');
});
