import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, nextNodeKey, outcomeLabel } from '../src/graphRoute.js';
import { decideOutcome } from '../src/roleEngine.js';
import { normalizeTaskRoute, roleKind, ROLE_FLOW } from '../src/rolePipeline.js';
import { taskRouteFromCard, applyReasoningVerdict, renderWorkArtifactSections } from '../src/db.js';
import { buildRoute } from '../src/projectRoute.js';

// Мини-клиент pg (как в других db-тестах): отвечает по первому подходящему правилу.
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

// TASK-ROUTER-001 — условная развилка контура через рёбра графа + метку branchLabel.

// Дев-граф с развилкой: Intake → Router → {Mini(small), Architect(fallback)} → Programmer.
function routerGraph() {
  const nodes = [
    { stageKey: 'INT',  kind: 'stage', roleCode: 'TASK_INTAKE_OFFICER', roleId: 'rI', status: 'BACKLOG' },
    { stageKey: 'RT',   kind: 'stage', roleCode: 'TASK_ROUTER',    roleId: 'rR', status: 'ARCHITECTURE' },
    { stageKey: 'MINI', kind: 'stage', roleCode: 'MINI_ARCHITECT', roleId: 'rM', status: 'ARCHITECTURE' },
    { stageKey: 'ARCH', kind: 'stage', roleCode: 'ARCHITECT',      roleId: 'rA', status: 'ARCHITECTURE' },
    { stageKey: 'PROG', kind: 'stage', roleCode: 'PROGRAMMER',     roleId: 'rP', status: 'CODING' },
  ];
  const edges = [
    { fromKey: 'INT',  toKey: 'RT',   condition: null,    position: 0 },
    { fromKey: 'RT',   toKey: 'MINI', condition: 'small', position: 0 },
    { fromKey: 'RT',   toKey: 'ARCH', condition: null,    position: 1 },
    { fromKey: 'MINI', toKey: 'PROG', condition: null,    position: 0 },
    { fromKey: 'ARCH', toKey: 'PROG', condition: null,    position: 0 },
  ];
  return buildGraph(nodes, edges);
}

// ───── outcomeLabel: явная метка ветки (branchLabel) перебивает success/failure ─────
test('outcomeLabel: branchLabel перебивает, пустой/нет — прежнее поведение', () => {
  assert.equal(outcomeLabel({ outcome: 'FORWARD', branchLabel: 'small' }), 'small');
  assert.equal(outcomeLabel({ outcome: 'FORWARD', branchLabel: 'medium' }), 'medium');
  assert.equal(outcomeLabel({ outcome: 'FORWARD', branchLabel: '  ' }), 'success', 'пустая метка игнорируется');
  assert.equal(outcomeLabel({ outcome: 'FORWARD' }), 'success');
  assert.equal(outcomeLabel({ outcome: 'BLOCK' }), 'failure');
  assert.equal(outcomeLabel({ outcome: 'REWORK' }), 'failure');
});

// ───── nextNodeKey: развилка Router по route ─────
test('nextNodeKey: Intake→Router; Router→Mini(small)/Architect(иначе); оба→Programmer', () => {
  const g = routerGraph();
  assert.equal(nextNodeKey(g, 'INT', { outcome: 'FORWARD' }), 'RT', 'Приёмщик → Router');
  assert.equal(nextNodeKey(g, 'RT', { outcome: 'FORWARD', branchLabel: 'small' }), 'MINI', 'small → Mini Architect');
  assert.equal(nextNodeKey(g, 'RT', { outcome: 'FORWARD', branchLabel: 'medium' }), 'ARCH', 'medium → полный Architect (fallback)');
  assert.equal(nextNodeKey(g, 'RT', { outcome: 'FORWARD', branchLabel: 'large' }), 'ARCH', 'large → полный Architect (fallback)');
  assert.equal(nextNodeKey(g, 'MINI', { outcome: 'FORWARD' }), 'PROG', 'Mini → Programmer');
  assert.equal(nextNodeKey(g, 'ARCH', { outcome: 'FORWARD' }), 'PROG', 'Architect → Programmer');
});

// ───── decideOutcome: TASK_ROUTER ─────
test('decideOutcome: TASK_ROUTER FORWARD несёт route меткой ветки (branchLabel)', () => {
  const d = decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small' } });
  assert.equal(d.outcome, 'FORWARD');
  assert.equal(d.branchLabel, 'small');
  assert.equal(d.reason, 'route_small');
});

test('decideOutcome: TASK_ROUTER мусорный/пустой route → medium (fallback к Architect)', () => {
  assert.equal(decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'huge' } }).branchLabel, 'medium');
  assert.equal(decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: {} }).branchLabel, 'medium');
});

test('decideOutcome: TASK_ROUTER needs_clarification → BLOCK; «no»/пусто → не блокирует', () => {
  const blocked = decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small', needs_clarification: true } });
  assert.equal(blocked.outcome, 'BLOCK');
  assert.equal(blocked.reason, 'router_needs_clarification');
  const blockedStr = decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small', needs_clarification: 'да, какой проект?' } });
  assert.equal(blockedStr.outcome, 'BLOCK');
  // Отрицательные значения не блокируют.
  assert.equal(decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small', needs_clarification: 'false' } }).outcome, 'FORWARD');
  assert.equal(decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small', needs_clarification: 'no' } }).outcome, 'FORWARD');
  assert.equal(decideOutcome('TASK_ROUTER', { ok: true, status: 'READY', fields: { route: 'small', needs_clarification: '' } }).outcome, 'FORWARD');
});

test('decideOutcome: TASK_ROUTER явный BLOCKED-вердикт → BLOCK', () => {
  const d = decideOutcome('TASK_ROUTER', { ok: false, status: 'BLOCKED', fields: {} });
  assert.equal(d.outcome, 'BLOCK');
});

// ───── decideOutcome: MINI_ARCHITECT (как ARCHITECT) ─────
test('decideOutcome: MINI_ARCHITECT READY→FORWARD, BLOCKED→BLOCK', () => {
  assert.equal(decideOutcome('MINI_ARCHITECT', { ok: true, status: 'READY' }).outcome, 'FORWARD');
  const b = decideOutcome('MINI_ARCHITECT', { ok: false, status: 'BLOCKED' });
  assert.equal(b.outcome, 'BLOCK');
});

// ───── ROLE_FLOW / ROLE_KINDS канонический фолбэк ─────
test('ROLE_FLOW: Intake→Router→Architect(fallback), Mini→Programmer; from непустые', () => {
  assert.equal(ROLE_FLOW.TASK_INTAKE_OFFICER.next, 'TASK_ROUTER');
  assert.equal(ROLE_FLOW.TASK_ROUTER.next, 'ARCHITECT', 'канонический фолбэк — полный Архитектор');
  assert.equal(ROLE_FLOW.MINI_ARCHITECT.next, 'PROGRAMMER');
  assert.ok(ROLE_FLOW.TASK_ROUTER.from.length > 0);
  assert.ok(ROLE_FLOW.MINI_ARCHITECT.from.length > 0);
  assert.equal(roleKind('TASK_ROUTER'), 'router');
  assert.equal(roleKind('MINI_ARCHITECT'), 'design');
});

// ───── normalizeTaskRoute / taskRouteFromCard ─────
test('normalizeTaskRoute: small|medium|large, мусор/пусто → medium', () => {
  assert.equal(normalizeTaskRoute('small'), 'small');
  assert.equal(normalizeTaskRoute('LARGE'), 'large');
  assert.equal(normalizeTaskRoute('  Medium '), 'medium');
  assert.equal(normalizeTaskRoute('huge'), 'medium');
  assert.equal(normalizeTaskRoute(undefined), 'medium');
  assert.equal(normalizeTaskRoute(null), 'medium');
});

test('taskRouteFromCard: из объекта и JSON-строки, отсутствие → medium', () => {
  assert.equal(taskRouteFromCard({ route: 'small' }), 'small');
  assert.equal(taskRouteFromCard('{"route":"large"}'), 'large');
  assert.equal(taskRouteFromCard({}), 'medium');
  assert.equal(taskRouteFromCard(null), 'medium');
  assert.equal(taskRouteFromCard('not json'), 'medium');
});

// ───── applyReasoningVerdict: ветка MINI_ARCHITECT (small-контур) ─────
// MINI гарантирует service_id (как ARCHITECT, но без split) и кладёт сфокусированный
// work item в task.description (item 7 — Программист видит его в «## Task Description»).
const MINI_ROUTE = buildRoute([
  { position: 0, enabled: true, taskStatus: 'ARCHITECTURE', roleCodes: ['MINI_ARCHITECT'] },
  { position: 1, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
]);

test('MINI_ARCHITECT FORWARD → Programmer (CODING) + work item в описании задачи', async () => {
  const c = fakeClient([
    // ensureArchitectService: у задачи уже есть service_id → пропуск (не резолвим).
    { re: /SELECT service_id FROM tasks WHERE id = \$1/, reply: { rowCount: 1, rows: [{ service_id: 'svc-1' }] } },
    // preflight эффективного сервиса — валидный путь при невидимом корне → ok.
    { re: /FROM services s JOIN projects p/, reply: {
      rowCount: 1, rows: [{ service_code: 'Front', repository_path: 'CRM/Front', root_path: 'K:\\no\\such\\root' }],
    } },
    // roleIdByCode(PROGRAMMER) в finalizeRole.
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    // finalizeRole: строка задачи под блокировкой.
    { re: /FROM tasks WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'ARCHITECTURE' }] } },
  ]);

  const res = await applyReasoningVerdict(c, {
    id: 't1', project_id: 'p1', description: 'исходное', data_card: {},
    role_code: 'MINI_ARCHITECT', role_id: 'rM', agentRunId: 'run1', status: 'ARCHITECTURE',
    current_stage_key: null,
  }, {
    route: MINI_ROUTE, contract: { outputs: [] },
    verdict: {
      status: 'READY', ok: true, summary: 's', findings: [], fields: {
        work_item: 'Сделать кнопку зелёной', target_service: 'Front', target_area: 'Cart',
        acceptance_criteria: ['кнопка зелёная', 'нет ошибок в консоли'], scope_limits: 'только CSS',
      },
    },
    response: '', exchangeId: 'ex1', durationMs: 1,
  });

  assert.equal(res.toStatus, 'CODING', 'MINI форвардит к Программисту (CODING)');
  assert.equal(res.nextRole, 'PROGRAMMER');
  // Расщепления НЕТ (small = один сервис).
  assert.equal(c.calls.some((q) => /INSERT INTO work_stack/.test(q.sql)), false, 'MINI не расщепляет');
  // Описание задачи обновлено сфокусированным work item.
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd, 'задача продвинута finalizeRole');
  assert.equal(upd.params[1], 'CODING');
  assert.equal(upd.params[2], 'rProg', 'next role = Programmer');
  assert.ok(/description = \$\d+/.test(upd.sql), 'UPDATE задаёт description');
  const descParam = upd.params[5];
  assert.match(descParam, /Сделать кнопку зелёной/, 'work item в описании');
  assert.match(descParam, /Критерии приёмки/, 'критерии приёмки в описании');
  assert.match(descParam, /кнопка зелёная/);
  assert.match(descParam, /только CSS/, 'границы scope в описании');
});

// ───── renderWorkArtifactSections (item 7) — только заполненные секции ─────
test('renderWorkArtifactSections: пусто → ""; заполненные секции рендерятся', () => {
  assert.equal(renderWorkArtifactSections(), '');
  assert.equal(renderWorkArtifactSections({}), '');
  assert.equal(renderWorkArtifactSections({ acceptance_criteria: [], scope_limits: '' }), '');
  const full = renderWorkArtifactSections({
    acceptance_criteria: ['a', 'b'], scope_limits: 'только X', test_plan: 'юнит', risk_notes: 'риск R',
  });
  assert.match(full, /## Критерии приёмки\n- a\n- b/);
  assert.match(full, /## Границы \(не трогать\)\nтолько X/);
  assert.match(full, /## План проверки\nюнит/);
  assert.match(full, /## Риски\nриск R/);
  // Только заполненные: одни критерии → нет прочих секций.
  const partial = renderWorkArtifactSections({ acceptance_criteria: 'единственный критерий' });
  assert.match(partial, /## Критерии приёмки\n- единственный критерий/);
  assert.ok(!/## Границы/.test(partial));
  assert.ok(!/## План проверки/.test(partial));
  // test_hints — фолбэк для «плана проверки», если нет test_plan.
  assert.match(renderWorkArtifactSections({ test_hints: 'проверь кнопку' }), /## План проверки\nпроверь кнопку/);
});

// ───── applyReasoningVerdict: ARCHITECT одиночный путь доливает артефакты в описание ─────
test('ARCHITECT (одиночный путь) доливает критерии/границы в ХВОСТ описания задачи', async () => {
  const c = fakeClient([
    // resolveArchitectSplit: work_items нет → 0 сервисов → одиночный путь (не split).
    { re: /FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
    // ensureArchitectService: service_id уже задан → пропуск.
    { re: /SELECT service_id FROM tasks WHERE id = \$1/, reply: { rowCount: 1, rows: [{ service_id: 'svc-1' }] } },
    { re: /FROM services s JOIN projects p/, reply: {
      rowCount: 1, rows: [{ service_code: 'Svc', repository_path: 'CRM/Svc', root_path: 'K:\\no\\such\\root' }],
    } },
    { re: /FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /FROM tasks WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'ARCHITECTURE' }] } },
  ]);
  const res = await applyReasoningVerdict(c, {
    id: 't1', project_id: 'p1', description: 'Базовое описание задачи', data_card: {},
    role_code: 'ARCHITECT', role_id: 'rA', agentRunId: 'run1', status: 'ARCHITECTURE',
    current_stage_key: null,
  }, {
    route: buildRoute([
      { position: 0, enabled: true, taskStatus: 'ARCHITECTURE', roleCodes: ['ARCHITECT'] },
      { position: 1, enabled: true, taskStatus: 'CODING', roleCodes: ['PROGRAMMER'] },
    ]),
    contract: { outputs: [] },
    verdict: {
      status: 'READY', ok: true, summary: 's', findings: [], fields: {
        acceptance_criteria: ['крит 1', 'крит 2'], scope_limits: 'не менять контракт API', test_plan: 'юнит-тесты',
      },
    },
    response: '', exchangeId: 'ex1', durationMs: 1,
  });
  assert.equal(res.toStatus, 'CODING');
  assert.equal(res.nextRole, 'PROGRAMMER');
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd && /description = \$\d+/.test(upd.sql), 'описание обновлено');
  const desc = upd.params[5];
  assert.match(desc, /^Базовое описание задачи/, 'базовое описание сохранено в начале');
  assert.match(desc, /## Критерии приёмки\n- крит 1\n- крит 2/, 'критерии дописаны в хвост');
  assert.match(desc, /## Границы \(не трогать\)\nне менять контракт API/);
  assert.match(desc, /## План проверки\nюнит-тесты/);
});
