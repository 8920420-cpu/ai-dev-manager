import test from 'node:test';
import assert from 'node:assert/strict';
import { completeHostTaskTx, acceptScannerCompletionTx, __resetRoleFieldsCacheForTests } from '../src/db.js';

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

// ───── Строгий режим контракта полей при сдаче Programmer ─────
// Базовые правила fake-клиента для acceptScannerCompletionTx: проект найден,
// существующая задача в CODING под PROGRAMMER, dispatch вставлен (не дубль),
// маршрут проекта пуст (фолбэк REVIEW/TASK_REVIEWER), таблица role_fields есть.
const scannerBaseRules = () => [
  { re: /SELECT id, code FROM projects/, reply: { rowCount: 1, rows: [{ id: 'proj-1', code: 'PS' }] } },
  {
    re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
    reply: { rowCount: 1, rows: [{
      id: TASK, status: 'CODING', project_id: 'proj-1', project_code: 'PS',
      service_code: 'Catalog_Service', reviewer_role_id: 'rev-1',
      current_role_id: 'role-prog', current_role_code: 'PROGRAMMER',
    }] },
  },
  { re: /INSERT INTO scanner_dispatches/, reply: { rowCount: 1, rows: [{ id: 'disp-1' }] } },
  { re: /FROM project_stages WHERE project_id/, reply: { rowCount: 0, rows: [] } },
  { re: /to_regclass\('public\.role_fields'\)/, reply: { rowCount: 1, rows: [{ t: 'role_fields' }] } },
  { re: /FROM role_fields rf/, reply: { rowCount: 1, rows: [{ direction: 'out', required: true, key: 'diff' }] } },
];

const scannerPayload = (over = {}) => ({
  taskId: TASK, completionKey: 'k1', project: 'PS', service: 'Catalog_Service',
  title: 'T', result: 'done', changedFiles: [], ...over,
});

test('сдача без обязательного поля контракта → 422 missing_required_fields, ROLLBACK', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  await assert.rejects(
    () => acceptScannerCompletionTx(c, scannerPayload({ fields: {} })),
    (e) => e.statusCode === 422 && e.code === 'missing_required_fields'
      && Array.isArray(e.errors) && e.errors.includes('diff'),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks/.test(q.sql)), false, 'задача не продвигается');
  assert.equal(c.calls.some((q) => /ROLLBACK/.test(q.sql)), true, 'транзакция откатана (dispatch тоже)');
  assert.equal(c.calls.some((q) => /COMMIT/.test(q.sql)), false, 'без COMMIT');
});

test('сдача с заполненным обязательным полем → принята, переход к Reviewer', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({ fields: { diff: 'patch text' } }));
  assert.equal(res.accepted, true);
  assert.equal(res.duplicate, false);
  assert.equal(res.nextRole, 'TASK_REVIEWER');
  const upd = c.calls.find((q) => /UPDATE tasks/.test(q.sql));
  assert.ok(upd, 'задача продвинута');
  assert.equal(upd.params[1], 'REVIEW');
  assert.equal(c.calls.some((q) => /COMMIT/.test(q.sql)), true, 'транзакция зафиксирована');
});

// PROGRAMMER-UNIFY-001: успешная сдача программиста финализирует RUNNING-прогон
// (созданный при захвате) в SUCCESS с KPI — turns(=passes), model, code_version —
// чтобы PROGRAMMER считался в «Мониторе» и версиях единообразно с ИИ-ролями.
test('сдача программиста → agent_run финализируется в SUCCESS с turns/model/codeVersion', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({
    fields: { diff: 'patch text' }, numTurns: 4, model: 'claude-opus-4-8', codeVersion: 'abc123',
  }));
  assert.equal(res.accepted, true);
  const run = c.calls.find((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  assert.ok(run, 'RUNNING-прогон программиста финализирован в SUCCESS');
  assert.equal(run.params[1], 4, 'turns = numTurns (число проходов)');
  assert.equal(run.params[2], 'claude-opus-4-8', 'model из сдачи');
  assert.equal(run.params[3], 'abc123', 'code_version из сдачи');
  assert.equal(run.params[5], 'role-prog', 'финализируется прогон роли захвата (PROGRAMMER)');
  // Прогон закрывается строго ВНУТРИ транзакции — до COMMIT.
  const runIdx = c.calls.findIndex((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  const commitIdx = c.calls.findIndex((q) => /COMMIT/.test(q.sql));
  assert.ok(runIdx >= 0 && commitIdx > runIdx, 'финализация прогона до COMMIT');
});

// Дубль сдачи (уже принятый completionKey) НЕ финализирует прогон повторно: он уже
// закрыт первой сдачей, иначе повторно затёрли бы KPI.
test('дубль сдачи программиста не трогает agent_run', async () => {
  __resetRoleFieldsCacheForTests();
  const rules = scannerBaseRules();
  rules[2] = { re: /INSERT INTO scanner_dispatches/, reply: { rowCount: 0, rows: [] } }; // ON CONFLICT → дубль
  const c = fakeClient(rules);
  const res = await acceptScannerCompletionTx(c, scannerPayload({ fields: { diff: 'x' }, numTurns: 2 }));
  assert.equal(res.duplicate, true);
  assert.equal(c.calls.some((q) => /UPDATE agent_runs/.test(q.sql)), false, 'прогон повторно не финализируется');
});

test('контракт без обязательных полей → требований нет, сдача проходит', async () => {
  __resetRoleFieldsCacheForTests();
  const rules = scannerBaseRules();
  // role_fields без обязательных выходов (только необязательное поле).
  rules[rules.length - 1] = { re: /FROM role_fields rf/, reply: { rowCount: 1, rows: [{ direction: 'out', required: false, key: 'notes' }] } };
  const c = fakeClient(rules);
  const res = await acceptScannerCompletionTx(c, scannerPayload({ fields: {} }));
  assert.equal(res.accepted, true);
  assert.equal(res.nextRole, 'TASK_REVIEWER');
  assert.equal(c.calls.some((q) => /COMMIT/.test(q.sql)), true);
});

// BOOT-RECONCILE-GRACE-001 (требование 2): поздняя успешная сдача программиста
// переписывает исход прогона, уже помеченного boot-жнецом TIMEOUT, на SUCCESS —
// финализирующий запрос сопоставляет последний прогон в RUNNING ЛИБО TIMEOUT.
test('поздняя сдача программиста переписывает TIMEOUT-прогон (RUNNING|TIMEOUT)', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({ fields: { diff: 'x' }, numTurns: 3 }));
  assert.equal(res.accepted, true);
  const run = c.calls.find((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  assert.ok(run, 'прогон программиста финализирован');
  // Ключ фикса: матчим не только RUNNING, но и TIMEOUT (осиротевший boot-реапом).
  assert.ok(/status IN \('RUNNING','TIMEOUT'\)/.test(run.sql), 'сопоставляется RUNNING ИЛИ TIMEOUT');
  assert.ok(/ORDER BY started_at DESC LIMIT 1/.test(run.sql), 'берётся последний прогон (свежий RUNNING приоритетнее старого TIMEOUT)');
});

// BOOT-RECONCILE-GRACE-001 (требование 2): host-runner переживает рестарт и досылает
// результат ПОСЛЕ boot-жнеца, который уже снял assigned_agent_id и пометил прогон
// TIMEOUT. Поздняя сдача должна переписать прогон даже при assigned_agent_id = NULL.
test('поздняя сдача host-роли переписывает TIMEOUT-прогон при assigned_agent_id = NULL', async () => {
  const c = fakeClient([
    {
      re: lookup,
      // assigned_agent_id = NULL — слот уже освобождён boot-реапом, но прогон в TIMEOUT.
      reply: { rowCount: 1, rows: [{ id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null, role_code: 'PIPELINE_SERVICE' }] },
    },
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'role-da' }] } },
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'PIPELINE_SERVICE', success: true, output: { summary: { ok: true } } });
  assert.equal(res.accepted, true);
  assert.equal(res.toStatus, 'COMMIT');

  const run = c.calls.find((q) => /UPDATE agent_runs SET status = \$2::agent_run_status/.test(q.sql));
  assert.ok(run, 'прогон host-роли финализируется даже без assigned_agent_id (иначе KPI навсегда TIMEOUT)');
  assert.ok(/status IN \('RUNNING','TIMEOUT'\)/.test(run.sql), 'сопоставляется RUNNING ИЛИ TIMEOUT');
  assert.equal(run.params[1], 'SUCCESS', 'исход переписан на фактический SUCCESS');
  assert.equal(run.params[3], 'role-pipe', 'по роли захвата прогона (current_role_id)');
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
