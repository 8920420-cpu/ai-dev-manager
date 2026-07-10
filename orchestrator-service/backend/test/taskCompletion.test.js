import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completeHostTaskTx, acceptScannerCompletionTx, resolveHostTaskContext,
  normalizeScannerCompletion, __resetRoleFieldsCacheForTests, deriveHostFailureText,
} from '../src/db.js';

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
  // Раскладка параметров runKpiSet(kpi, 2): $1 taskId, $2 output_json, затем KPI
  // $3..$12 (tokenInput, tokenOutput, cost, coldStartMs, turns, outcome, codeVersion,
  // model, tokenCacheRead, tokenCacheCreation), $13 roleId.
  assert.equal(run.params[6], 4, 'turns = numTurns (число проходов)');
  assert.equal(run.params[9], 'claude-opus-4-8', 'model из сдачи');
  assert.equal(run.params[8], 'abc123', 'code_version из сдачи');
  assert.equal(run.params[12], 'role-prog', 'финализируется прогон роли захвата (PROGRAMMER)');
  // Прогон закрывается строго ВНУТРИ транзакции — до COMMIT.
  const runIdx = c.calls.findIndex((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  const commitIdx = c.calls.findIndex((q) => /COMMIT/.test(q.sql));
  assert.ok(runIdx >= 0 && commitIdx > runIdx, 'финализация прогона до COMMIT');
});

// OBSERVABILITY-PROGRAMMER-KPI-001 (а): сдача с usage/cost/cold start → agent_run
// программиста получает token_input/token_output/token_cache_read/token_cache_creation/
// cost/cold_start_ms из тела сдачи (контракт tokensIn/…/coldStartMs), маппинг через
// normalizeRunKpi/runKpiSet — так же, как у рассуждающих ролей.
test('сдача программиста с usage/cost/coldStart → agent_run получает token/cost/cold_start', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({
    fields: { diff: 'patch' }, numTurns: 30, model: 'claude-opus-4-8', codeVersion: 'v1',
    tokensIn: 12000, tokensOut: 3400, tokensCacheRead: 8000, tokensCacheCreation: 1500,
    costUsd: 0.4212, coldStartMs: 950,
  }));
  assert.equal(res.accepted, true);
  const run = c.calls.find((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  assert.ok(run, 'прогон программиста финализирован');
  // KPI-колонки присутствуют в SET (usage/cost/cold start больше не теряются).
  assert.ok(/token_input = COALESCE/.test(run.sql), 'token_input в SET');
  assert.ok(/token_output = COALESCE/.test(run.sql), 'token_output в SET');
  assert.ok(/cost = COALESCE/.test(run.sql), 'cost в SET');
  assert.ok(/cold_start_ms =/.test(run.sql), 'cold_start_ms в SET');
  assert.ok(/token_cache_read = COALESCE/.test(run.sql), 'token_cache_read в SET');
  assert.ok(/token_cache_creation = COALESCE/.test(run.sql), 'token_cache_creation в SET');
  // Значения из тела сдачи (раскладка runKpiSet(kpi, 2): $3..$12 — см. тест выше).
  assert.equal(run.params[2], 12000, 'token_input = tokensIn');
  assert.equal(run.params[3], 3400, 'token_output = tokensOut');
  assert.equal(run.params[4], 0.4212, 'cost = costUsd');
  assert.equal(run.params[5], 950, 'cold_start_ms = coldStartMs');
  assert.equal(run.params[10], 8000, 'token_cache_read = tokensCacheRead');
  assert.equal(run.params[11], 1500, 'token_cache_creation = tokensCacheCreation');
});

// OBSERVABILITY-PROGRAMMER-KPI-001 (б): старый раннер без usage-полей → финализация
// не падает, а COALESCE-колонки не затираются (передаются NULL → сохраняется прежнее
// значение). Обратная совместимость обязательна.
test('сдача программиста без usage (старый раннер) → без падения, KPI не обнуляются насильно', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({ fields: { diff: 'patch' }, numTurns: 12 }));
  assert.equal(res.accepted, true);
  const run = c.calls.find((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  assert.ok(run, 'прогон финализирован даже без usage-полей');
  // token_input/output/cost/cache идут через COALESCE(NULL, col) → прежние значения
  // не затираются.
  assert.ok(/token_input = COALESCE\(\$\d+, token_input\)/.test(run.sql), 'token_input через COALESCE');
  assert.ok(/cost = COALESCE\(\$\d+, cost\)/.test(run.sql), 'cost через COALESCE');
  assert.equal(run.params[2], null, 'tokensIn отсутствует → NULL (COALESCE сохранит записанное)');
  assert.equal(run.params[3], null, 'tokensOut отсутствует → NULL');
  assert.equal(run.params[4], null, 'costUsd отсутствует → NULL');
  assert.equal(run.params[10], null, 'tokensCacheRead отсутствует → NULL');
  assert.equal(run.params[11], null, 'tokensCacheCreation отсутствует → NULL');
  // turns есть у любого раннера (число проходов) — проставляется.
  assert.equal(run.params[6], 12, 'turns = numTurns');
});

// COMPLETION-SUMMARY-TEXT-001 (в): result пришёл ОБЪЕКТОМ { summary, ... } — в
// task_events и в output_json прогона кладём читаемый текст summary, а не
// «[object Object]» (его же тянет priorRoleOutputs в контекст следующих ролей).
test('result-объект → в task_events и output_json читаемый summary, не «[object Object]»', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const readable = 'Добавил маппинг usage/cost/cold start в agent_runs';
  const res = await acceptScannerCompletionTx(c, scannerPayload({
    fields: { diff: 'patch' },
    result: { summary: readable, outcome: 'DONE' },
  }));
  assert.equal(res.accepted, true);
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql) && /STATUS_CHANGED/.test(q.sql));
  assert.ok(ev, 'событие перехода записано');
  const evPayload = JSON.parse(ev.params[3]);
  assert.equal(evPayload.result, readable, 'в task_events читаемый текст summary');
  assert.notEqual(evPayload.result, '[object Object]', 'объект не сериализован через String()');
  // output_json прогона тоже с текстовым summary.
  const run = c.calls.find((q) => /UPDATE agent_runs[\s\S]*status = 'SUCCESS'/.test(q.sql));
  const out = JSON.parse(run.params[1]);
  assert.equal(out.summary, readable, 'output_json прогона хранит текст, а не объект');
});

// COMPLETION-SUMMARY-TEXT-001 (в, приоры): resolveHostTaskContext извлекает текстовый
// summary из события, где result записан объектом, — так следующая host-роль получает
// читаемый programmerResult вместо «[object Object]».
test('resolveHostTaskContext: result-объект события → приоры получают текст', async () => {
  const c = fakeClient([
    { re: /WITH RECURSIVE chain/, reply: { rowCount: 1, rows: [{ id: TASK, title: 'T', description: 'D', depth: 0 }] } },
    {
      re: /SELECT payload_json FROM task_events/,
      reply: { rowCount: 1, rows: [{ payload_json: { changedFiles: ['a.js'], result: { summary: 'Сделал маппинг KPI' } } }] },
    },
  ]);
  const ctx = await resolveHostTaskContext(c, TASK);
  assert.equal(ctx.scan.payload_json.result, 'Сделал маппинг KPI', 'из объекта извлечён текст summary');
  assert.notEqual(ctx.scan.payload_json.result, '[object Object]');
  assert.deepEqual(ctx.scan.payload_json.changedFiles, ['a.js'], 'changedFiles сохранены');
});

// COMPLETION-SUMMARY-TEXT-001 + контракт usage: продакшн-путь нормализации тела сдачи
// (POST /api/scanner/task-completed → normalizeScannerCompletion). result-объект →
// текст summary; changedFiles и usage/cost/coldStart проброшены дальше в finalize.
test('normalizeScannerCompletion: result-объект → текст; changedFiles и usage проброшены', () => {
  const norm = normalizeScannerCompletion({
    taskId: TASK, completionKey: 'k1', project: 'PS', service: 'Catalog_Service',
    title: 'T', sourceDocument: 'doc.md',
    result: { summary: 'Готово: маппинг KPI', outcome: 'DONE' },
    changedFiles: ['a.js', 'b.js'],
    tokensIn: 100, tokensOut: 50, tokensCacheRead: 20, tokensCacheCreation: 5,
    costUsd: 0.01, coldStartMs: 300,
  });
  assert.equal(norm.result, 'Готово: маппинг KPI', 'result — текст summary, не «[object Object]»');
  assert.deepEqual(norm.changedFiles, ['a.js', 'b.js'], 'changedFiles сохранены (нужны Git Integrator)');
  assert.equal(norm.tokensIn, 100);
  assert.equal(norm.tokensOut, 50);
  assert.equal(norm.tokensCacheRead, 20);
  assert.equal(norm.tokensCacheCreation, 5);
  assert.equal(norm.costUsd, 0.01);
  assert.equal(norm.coldStartMs, 300);
  // Старый раннер без usage-полей → null (обратная совместимость, не падение).
  const legacy = normalizeScannerCompletion({
    taskId: TASK, completionKey: 'k2', project: 'PS', service: 'Catalog_Service',
    title: 'T', sourceDocument: 'doc.md', result: 'plain text',
  });
  assert.equal(legacy.result, 'plain text', 'строковый result — как есть');
  assert.equal(legacy.tokensIn, null);
  assert.equal(legacy.costUsd, null);
  assert.equal(legacy.coldStartMs, null);
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

// STALE-COMPLETION-ROLE-GUARD-001: дубль/опоздавшая сдача программиста, пришедшая
// когда задача уже ушла в TESTING под PIPELINE_SERVICE (pipeline ещё бежит), НЕ
// должна закрывать этап. completionKey кодирует роль сдачи (префикс `programmer-`);
// если текущая роль задачи — не PROGRAMMER, сдача помечается stale и маршрут не
// продвигается, agent_run PIPELINE_SERVICE не затирается. Этап TESTING закрывает
// только сдача host pipeline (completeHostTaskTx с roleCode=PIPELINE_SERVICE).
test('дубль сдачи программиста в TESTING (под PIPELINE_SERVICE) → игнор, этап не закрывается', async () => {
  __resetRoleFieldsCacheForTests();
  const rules = scannerBaseRules();
  rules[1] = {
    re: /FROM tasks t[\s\S]*FOR UPDATE OF t/,
    reply: { rowCount: 1, rows: [{
      id: TASK, status: 'TESTING', project_id: 'proj-1', project_code: 'PS',
      service_code: 'Catalog_Service', reviewer_role_id: 'rev-1',
      current_role_id: 'role-pipe', current_role_code: 'PIPELINE_SERVICE',
    }] },
  };
  const c = fakeClient(rules);
  const res = await acceptScannerCompletionTx(c, scannerPayload({
    completionKey: `programmer-${TASK}-assigned-1`, fields: { diff: 'x' }, numTurns: 28,
  }));

  assert.equal(res.accepted, true);
  assert.equal(res.stale, true, 'опоздавшая сдача программиста помечена stale');
  assert.equal(res.duplicate, true);
  assert.equal(res.nextRole, null, 'маршрут НЕ продвигается чужой сдачей');
  assert.equal(res.currentRole, 'PIPELINE_SERVICE');
  assert.equal(c.calls.some((q) => /UPDATE tasks/.test(q.sql)), false, 'статус задачи не меняется');
  assert.equal(c.calls.some((q) => /INSERT INTO task_events/.test(q.sql)), false, 'событие перехода не пишется');
  assert.equal(c.calls.some((q) => /UPDATE agent_runs/.test(q.sql)), false, 'прогон PIPELINE_SERVICE не затирается сдачей программиста');
  assert.equal(c.calls.some((q) => /COMMIT/.test(q.sql)), true, 'dispatch зафиксирован (сдача увидена и проигнорирована)');
});

// Контроль: та же сдача программиста, когда задача РЕАЛЬНО в CODING под PROGRAMMER,
// проходит штатно (guard не ложно-срабатывает на легитимной сдаче).
test('сдача программиста в CODING под PROGRAMMER (ключ programmer-…) → принята, не stale', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient(scannerBaseRules());
  const res = await acceptScannerCompletionTx(c, scannerPayload({
    completionKey: `programmer-${TASK}-assigned-1`, fields: { diff: 'patch' },
  }));
  assert.equal(res.accepted, true);
  assert.notEqual(res.stale, true, 'легитимная сдача не помечается stale');
  assert.equal(res.nextRole, 'TASK_REVIEWER');
  assert.ok(c.calls.find((q) => /UPDATE tasks/.test(q.sql)), 'задача продвинута');
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

// ───── FORK-JOIN-001: сдача host-роли в ГРАФ-режиме (current_stage_key задан) ─────
// Маршрут проекта «Оркестратор»: … → Pipeline Service(TESTING) → Failure Analyst →
// Fork → ветки(Doc Auditor/Git Integrator) → Join. Рёбра сгенерированы линейно, БЕЗ
// меток условий (Failure Analyst стоит по позиции сразу за Pipeline Service).
// Правила graph-режима: узлы/рёбра проекта + gate-роль fork.
const orchestratorGraphRules = () => [
  {
    re: /FROM project_stages WHERE project_id/,
    reply: {
      rowCount: 5,
      rows: [
        { id: 'sPS', position: 5, enabled: true, task_status: 'TESTING', stage_key: 'PS', kind: 'stage', join_key: null, name: 'Pipeline Service' },
        { id: 'sFA', position: 6, enabled: true, task_status: 'FAILURE_ANALYSIS', stage_key: 'FA', kind: 'stage', join_key: null, name: 'Failure Analyst' },
        { id: 'sFORK', position: 7, enabled: true, task_status: null, stage_key: 'FORK', kind: 'fork', join_key: 'JOIN', name: 'Fork' },
        { id: 'sB', position: 8, enabled: true, task_status: 'COMMIT', stage_key: 'B', kind: 'stage', join_key: null, name: 'Doc Auditor' },
        { id: 'sJOIN', position: 11, enabled: true, task_status: null, stage_key: 'JOIN', kind: 'join', join_key: null, name: 'Join' },
      ],
    },
  },
  {
    re: /FROM project_stage_roles psr JOIN roles/,
    reply: {
      rowCount: 5,
      rows: [
        { stage_id: 'sPS', role_id: 'rPS', code: 'PIPELINE_SERVICE', position: 0 },
        { stage_id: 'sFA', role_id: 'rFA', code: 'FAILURE_ANALYST', position: 0 },
        { stage_id: 'sFORK', role_id: 'rFORK', code: 'FORK_GATE', position: 0 },
        { stage_id: 'sB', role_id: 'rB', code: 'DOCUMENTATION_AUDITOR', position: 0 },
        { stage_id: 'sJOIN', role_id: 'rJOIN', code: 'JOIN_GATE', position: 0 },
      ],
    },
  },
  {
    re: /FROM project_stage_edges WHERE project_id/,
    reply: {
      rowCount: 4,
      rows: [
        { from_key: 'PS', to_key: 'FA', condition: null, position: 0 },
        { from_key: 'FA', to_key: 'FORK', condition: null, position: 0 },
        { from_key: 'FORK', to_key: 'B', condition: null, position: 0 },
        { from_key: 'B', to_key: 'JOIN', condition: null, position: 0 },
      ],
    },
  },
  { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'role-next' }] } },
];

// Требование 1+2: успех Pipeline Service в граф-режиме ведёт к узлу FORK (а НЕ
// захардкоженный Documentation Auditor на родителе и НЕ Failure Analyst).
test('PIPELINE_SERVICE success (граф) → узел fork, минуя Doc Auditor на родителе и Failure Analyst', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient([
    {
      re: lookup,
      reply: { rowCount: 1, rows: [{
        id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null,
        project_id: 'proj-1', current_stage_key: 'PS', role_code: 'PIPELINE_SERVICE',
      }] },
    },
    ...orchestratorGraphRules(),
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'PIPELINE_SERVICE', success: true, output: { summary: { ok: true } } });

  assert.equal(res.nextRole, 'FORK_GATE', 'успех Pipeline Service → узел fork');
  assert.notEqual(res.nextRole, 'DOCUMENTATION_AUDITOR', 'НЕ хардкод Documentation Auditor');
  assert.notEqual(res.nextRole, 'FAILURE_ANALYST', 'зелёная задача НЕ уходит к Failure Analyst');

  const upd = c.calls.find((q) => /UPDATE tasks SET status/.test(q.sql));
  assert.equal(upd.params[4], 'FORK', 'current_stage_key перенесён на узел fork');
  assert.ok(c.calls.find((q) => /INSERT INTO pipeline_runs/.test(q.sql)), 'записан прогон пайплайна');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'STATUS_CHANGED');
  assert.notEqual(ev.params[3], 'FAILURE_ANALYSIS', 'зелёная задача не заходит в разбор провалов');
});

// Требование: провал Pipeline Service ведёт к Failure Analyst (ветка failure графа).
test('PIPELINE_SERVICE fail (граф) → Failure Analyst (FAILURE_ANALYSIS)', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient([
    {
      re: lookup,
      reply: { rowCount: 1, rows: [{
        id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null,
        project_id: 'proj-1', current_stage_key: 'PS', role_code: 'PIPELINE_SERVICE',
      }] },
    },
    ...orchestratorGraphRules(),
  ]);
  const res = await completeHostTaskTx(c, { taskId: TASK, roleCode: 'PIPELINE_SERVICE', success: false, output: { failedStage: 'unit', summary: { ok: false } } });

  assert.equal(res.nextRole, 'FAILURE_ANALYST', 'провал → Failure Analyst');
  assert.equal(res.toStatus, 'FAILURE_ANALYSIS');

  const upd = c.calls.find((q) => /UPDATE tasks SET status/.test(q.sql));
  assert.equal(upd.params[4], 'FA', 'current_stage_key перенесён на узел Failure Analyst');

  const run = c.calls.find((q) => /INSERT INTO pipeline_runs/.test(q.sql));
  assert.equal(run.params[1], 'FAILED', 'прогон пайплайна помечен FAILED');

  // HOST-FAILURE-TEXT-001: провал Pipeline Service → НЕПУСТОЙ структурированный
  // error_text с кодом причины в UPDATE agent_runs (монитор видит причину, не пустоту).
  const arUpd = c.calls.find((q) => /UPDATE agent_runs SET status/.test(q.sql));
  assert.ok(arUpd, 'закрыт прогон host-роли');
  assert.match(arUpd.sql, /error_text = \$5/, 'при провале выставляется error_text');
  assert.ok(arUpd.params[4] && arUpd.params[4].length > 0, 'error_text непустой');
  assert.match(arUpd.params[4], /^unit: /, 'error_text начинается с кода причины (failedStage)');
});

// HOST-FAILURE-TEXT-001: успех Pipeline Service НЕ выставляет error_text (нечего
// диагностировать) — $5 в UPDATE agent_runs отсутствует.
test('PIPELINE_SERVICE success → error_text не выставляется', async () => {
  __resetRoleFieldsCacheForTests();
  const c = fakeClient([
    {
      re: lookup,
      reply: { rowCount: 1, rows: [{
        id: TASK, status: 'TESTING', current_role_id: 'role-pipe', assigned_agent_id: null,
        project_id: 'proj-1', current_stage_key: 'PS', role_code: 'PIPELINE_SERVICE',
      }] },
    },
    ...orchestratorGraphRules(),
  ]);
  await completeHostTaskTx(c, { taskId: TASK, roleCode: 'PIPELINE_SERVICE', success: true, output: { summary: { ok: true } } });

  const arUpd = c.calls.find((q) => /UPDATE agent_runs SET status/.test(q.sql));
  assert.ok(arUpd, 'закрыт прогон host-роли');
  assert.doesNotMatch(arUpd.sql, /error_text/, 'при успехе error_text не трогаем');
  assert.equal(arUpd.params.length, 4, 'нет параметра error_text');
});

// HOST-FAILURE-TEXT-001: deriveHostFailureText — роль-агностичный НЕПУСТОЙ код
// причины из output упавшей host-роли. Единый формат с веткой GIT_INTEGRATOR.
test('deriveHostFailureText: только failedStage → код причины из стадии', () => {
  const txt = deriveHostFailureText('PIPELINE_SERVICE', { failedStage: 'unit', summary: { ok: false } });
  assert.equal(txt, 'unit: no structured detail');
});

test('deriveHostFailureText: только error.message → код и сообщение из ошибки', () => {
  const txt = deriveHostFailureText('PIPELINE_SERVICE', { error: { message: 'repository_path not found' } });
  assert.equal(txt, 'pipeline_service_failed: repository_path not found');
});

test('deriveHostFailureText: errorCode приоритетнее failedStage', () => {
  const txt = deriveHostFailureText('GIT_INTEGRATOR', {
    error: { code: 'integrate_conflict', message: 'patch failed' }, failedStage: 'merge',
  });
  assert.equal(txt, 'integrate_conflict: patch failed');
});

test('deriveHostFailureText: полностью пустой output → непустой фолбэк', () => {
  const txt = deriveHostFailureText('PIPELINE_SERVICE', {});
  assert.equal(txt, 'pipeline_service_failed: no structured detail');
  assert.ok(txt.length > 0, 'фолбэк непустой');
});

test('deriveHostFailureText: пустой roleCode → безопасный фолбэк роли', () => {
  const txt = deriveHostFailureText('', {});
  assert.equal(txt, 'host_role_failed: no structured detail');
});

test('deriveHostFailureText: длинный error_text усечён до предела', () => {
  const txt = deriveHostFailureText('PIPELINE_SERVICE', { error: { message: 'x'.repeat(5000) } });
  assert.ok(txt.length <= 500, 'error_text не длиннее 500');
});
