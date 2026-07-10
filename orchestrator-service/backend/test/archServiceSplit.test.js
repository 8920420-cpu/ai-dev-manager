import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveArchitectSplit,
  materializeArchitectSplit,
  advanceDecompositionParents,
} from '../src/db.js';
import { buildRoute } from '../src/projectRoute.js';

// Мини-клиент pg (как в decomposition.test.js/forkJoin.test.js): отвечает по
// первому подходящему правилу (regex по SQL).
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

function architectClaimed(overrides = {}) {
  return {
    id: 'epic1', project_id: 'p1', description: 'Родительское описание', data_card: {},
    role_code: 'ARCHITECT', role_id: 'rArch', agentRunId: 'run1', status: 'ARCHITECTURE',
    current_stage_key: null, ...overrides,
  };
}

// Линейный маршрут проекта: Архитектор → Программист.
const LINEAR_ROUTE = buildRoute([
  { position: 0, enabled: true, taskStatus: 'ARCHITECTURE', roleCodes: ['ARCHITECT'] },
  { position: 1, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
]);

const VERDICT = { status: 'READY', summary: 's', findings: [], ok: true };

// --- resolveArchitectSplit (граница решения «расщеплять или нет») --------------

test('resolveArchitectSplit: 2 РАЗНЫХ сервиса (регистронезависимо) → services.length === 2', async () => {
  const c = fakeClient([
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'svca', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
    { serviceCode: 'SVCB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
  ] };
  const out = await resolveArchitectSplit(c, architectClaimed(), {}, cardValues);
  assert.equal(out.services.length, 2, 'два разных сервиса — расщепляем');
  assert.deepEqual(out.services.map((s) => s.serviceId).sort(), ['sidA', 'sidB']);
  assert.equal(out.unresolved.length, 0);
});

test('resolveArchitectSplit: 1 сервис → services.length === 1 (расщепления не будет)', async () => {
  const c = fakeClient([
    { re: /FROM services WHERE project_id/, reply: { rowCount: 1, rows: [{ id: 'sidA', service_code: 'SvcA' }] } },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
  ] };
  const out = await resolveArchitectSplit(c, architectClaimed(), {}, cardValues);
  assert.equal(out.services.length, 1, 'один сервис — старое поведение');
});

test('resolveArchitectSplit: несколько work_items одного сервиса сливаются в один', async () => {
  const c = fakeClient([
    { re: /FROM services WHERE project_id/, reply: { rowCount: 1, rows: [{ id: 'sidA', service_code: 'SvcA' }] } },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A1', files: [{ path: 'a.js', what: 'x' }] },
    { serviceCode: 'svca', title: 'A2', files: [{ path: 'b.js', what: 'y' }] },
  ] };
  const out = await resolveArchitectSplit(c, architectClaimed(), {}, cardValues);
  assert.equal(out.services.length, 1, 'дедуп по serviceId');
  assert.equal(out.services[0].files.length, 2, 'файлы объединены');
});

test('resolveArchitectSplit: нерезолвленный serviceCode попадает в unresolved', async () => {
  const c = fakeClient([
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A', files: [] },
    { serviceCode: 'SvcB', title: 'B', files: [] },
    { serviceCode: 'SvcGhost', title: 'G', files: [] },
  ] };
  const out = await resolveArchitectSplit(c, architectClaimed(), {}, cardValues);
  assert.equal(out.services.length, 2);
  assert.deepEqual(out.unresolved, ['SvcGhost']);
});

// --- materializeArchitectSplit (линейный маршрут) ----------------------------

function splitRules(extra = []) {
  return [
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `child-${h}` }] }) },
    ...extra,
  ];
}

test('materializeArchitectSplit: 2 сервиса → 2 дочерние задачи + эпик WAITING_FOR_CHILDREN', async () => {
  const c = fakeClient(splitRules());
  const cardValues = { work_items: [
    { serviceCode: 'svca', title: 'Задача A', files: [{ path: 'a.js', what: 'делай A' }, { path: 'b.js', what: 'ещё A' }] },
    { serviceCode: 'svcb', title: 'Задача B', files: [{ path: 'c.js', what: 'делай B' }] },
  ] };

  const res = await materializeArchitectSplit(c, architectClaimed(), {
    verdict: VERDICT, response: '', exchangeId: 'ex1', durationMs: 1,
    decision: { outcome: 'FORWARD' }, cardValues, route: LINEAR_ROUTE,
  });

  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN');
  assert.equal(res.services, 2);
  assert.equal(res.nextRole, 'PROGRAMMER');

  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2, 'две независимые задачи-на-сервис');
  // Каждая дочерняя задача: свой service_id, статус CODING, роль Программиста,
  // линейный режим → current_stage_key = null, created_by='architect' (в SQL-литерале).
  for (const ins of svcInserts) {
    assert.ok(['sidA', 'sidB'].includes(ins.params[1]), 'свой service_id');
    assert.equal(ins.params[5], 'CODING', 'статус входа = CODING');
    assert.equal(ins.params[6], 'rProg', 'роль Программиста');
    assert.equal(ins.params[7], null, 'линейный режим — без current_stage_key');
    assert.match(ins.sql, /created_by/);
    assert.match(ins.sql, /'architect'/);
    assert.match(ins.params[4], /## Задание для сервиса Svc[AB]/i, 'раздел задания для сервиса в описании');
    assert.match(ins.params[4], /Родительское описание/, 'сохранено описание родителя');
  }
  // Карточка ребёнка отфильтрована по сервису (в work_items — только его элементы).
  const cardA = JSON.parse(c.calls.find((q) => /INSERT INTO tasks[\s\S]*'service'/.test(q.sql) && q.params[1] === 'sidA').params[8]);
  assert.equal(cardA.work_items.length, 1, 'в карточке ребёнка только его work_items');
  assert.equal(cardA.work_items[0].serviceCode, 'svca');

  const deps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql));
  assert.equal(deps.length, 2, 'эпик зависит от каждого ребёнка');

  const park = c.calls.find((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql));
  assert.ok(park, 'эпик помечен и припаркован в WAITING_FOR_CHILDREN');
  assert.match(park.sql, /status = 'WAITING_FOR_CHILDREN'/);
  assert.match(park.sql, /assigned_agent_id = NULL/);

  const run = c.calls.find((q) => /UPDATE agent_runs SET status = 'SUCCESS'/.test(q.sql));
  assert.ok(run, 'прогон Архитектора завершён SUCCESS');
  assert.match(run.params[1], /architect_service_split/);

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.match(ev.sql, /STATUS_CHANGED/);
  assert.match(ev.sql, /WAITING_FOR_CHILDREN/);
  const payload = JSON.parse(ev.params[3]);
  assert.equal(payload.role, 'ARCHITECT');
  assert.equal(payload.reason, 'architect_service_split');
  assert.equal(payload.services.length, 2, 'в payload список созданных задач');
  assert.ok(payload.services.every((s) => s.id && s.serviceCode), 'каждая запись — {id, serviceCode}');
});

test('materializeArchitectSplit: нерезолвленный serviceCode → unresolved в событии, без задачи', async () => {
  const c = fakeClient(splitRules());
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
    { serviceCode: 'SvcB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
    { serviceCode: 'SvcGhost', title: 'G', files: [{ path: 'g.js', what: 'w' }] },
  ] };

  const res = await materializeArchitectSplit(c, architectClaimed(), {
    verdict: VERDICT, response: '', exchangeId: 'ex1', durationMs: 1,
    decision: { outcome: 'FORWARD' }, cardValues, route: LINEAR_ROUTE,
  });

  assert.equal(res.services, 2, 'только зарегистрированные сервисы дают задачи');
  assert.deepEqual(res.unresolved, ['SvcGhost']);
  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2, 'по нерезолвленному сервису задачу не создаём');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  const payload = JSON.parse(ev.params[3]);
  assert.deepEqual(payload.unresolved, ['SvcGhost']);
});

test('materializeArchitectSplit: повторный вердикт (есть дети) → идемпотентно, без дублей', async () => {
  // Правило idempotency: у задачи уже есть дети → повторно не создаём.
  const c = fakeClient([
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 1, rows: [{ '?column?': 1 }] } },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A', files: [] },
    { serviceCode: 'SvcB', title: 'B', files: [] },
  ] };
  const res = await materializeArchitectSplit(c, architectClaimed(), {
    verdict: VERDICT, response: '', exchangeId: 'ex1', durationMs: 1,
    decision: { outcome: 'FORWARD' }, cardValues, route: LINEAR_ROUTE,
  });
  assert.equal(res.reason, 'already_decomposed');
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false, 'детей повторно не создаём');
  const run = c.calls.find((q) => /UPDATE agent_runs SET status = 'SUCCESS'/.test(q.sql));
  assert.match(run.params[1], /already_decomposed/);
});

// --- materializeArchitectSplit (граф-режим) ----------------------------------

test('материализация в граф-режиме: у детей корректный current_stage_key целевого узла', async () => {
  // Граф проекта: узел Архитектора ARCH → узел Программиста PROG (CODING).
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: 1, rows: [
      { from_key: 'ARCH', to_key: 'PROG', condition: null, position: 0 },
    ] } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: 1, rows: [
      { id: 'sProg', stage_key: 'PROG', kind: 'stage', join_key: null, name: 'Программист', enabled: true, task_status: 'CODING' },
    ] } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: 1, rows: [
      { stage_id: 'sProg', role_id: 'rProg', code: 'PROGRAMMER', position: 0 },
    ] } },
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `child-${h}` }] }) },
  ]);
  const cardValues = { work_items: [
    { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }] },
    { serviceCode: 'SvcB', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
  ] };

  const res = await materializeArchitectSplit(c, architectClaimed({ current_stage_key: 'ARCH' }), {
    verdict: VERDICT, response: '', exchangeId: 'ex1', durationMs: 1,
    decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });

  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN');
  assert.equal(res.nextRole, 'PROGRAMMER');
  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2);
  for (const ins of svcInserts) {
    assert.equal(ins.params[5], 'CODING', 'статус целевого узла');
    assert.equal(ins.params[6], 'rProg', 'роль целевого узла');
    assert.equal(ins.params[7], 'PROG', 'current_stage_key = ключ целевого узла Программиста');
  }
});

// --- Роллап эпика нового пути (advanceDecompositionParents) -------------------

test('роллап: эпик Архитектора с детьми-сервисами, все терминальны → DONE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rArch' },
    ] } },
    { re: /task_kind = 'service' AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1, 'эпик нового пути подхвачен роллапом');
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'DONE');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'TASK_DONE');
});

test('роллап: есть упавший ребёнок-сервис → эпик BLOCKED', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rArch' },
    ] } },
    { re: /task_kind = 'service' AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 1 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'BLOCKED');
});
