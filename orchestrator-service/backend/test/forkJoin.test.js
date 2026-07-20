import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceForkNodes, advanceJoinNodes } from '../src/db.js';

// Мини-клиент pg: отвечает по первому подходящему правилу (regex по SQL).
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

const PROJ = 'p1';
const PARENT = 'parent-1';

// Узлы/рёбра проекта: fork F → {B, C} → join J.
const NODES_ROWS = [
  { id: 'sB', stage_key: 'B', kind: 'stage', join_key: null, name: 'Ветка B', enabled: true, task_status: 'CODING' },
  { id: 'sC', stage_key: 'C', kind: 'stage', join_key: null, name: 'Ветка C', enabled: true, task_status: 'REVIEW' },
];
const NODE_ROLES = [
  { stage_id: 'sB', role_id: 'rB', code: 'PROGRAMMER', position: 0 },
  { stage_id: 'sC', role_id: 'rC', code: 'TASK_REVIEWER', position: 0 },
];
const EDGES_ROWS = [
  { from_key: 'F', to_key: 'B', condition: null, position: 0 },
  { from_key: 'F', to_key: 'C', condition: null, position: 1 },
];

test('FORK: родитель на fork порождает по подзадаче на ветку и паркуется в WAITING_FOR_CHILDREN', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'fork'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, title: 'Задача', description: 'd', service_id: null,
               status: 'CODING', current_role_id: 'rFork', current_stage_key: 'F', data_card: {}, join_key: 'J' }],
    } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: 2, rows: EDGES_ROWS } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: 2, rows: NODES_ROWS } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: 2, rows: NODE_ROLES } },
    { re: /FROM roles WHERE code = 'JOIN_GATE'/, reply: { rowCount: 1, rows: [{ id: 'rJoin' }] } },
    { re: /INSERT INTO tasks[\s\S]*RETURNING id/, reply: (hits) => ({ rowCount: 1, rows: [{ id: `child-${hits}` }] }) },
  ]);

  const n = await advanceForkNodes(c);
  assert.equal(n, 1, 'один родитель расщеплён');

  const childInserts = c.calls.filter((q) => /INSERT INTO tasks/.test(q.sql));
  assert.equal(childInserts.length, 2, 'по подзадаче на каждую ветку');

  const deps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql));
  assert.equal(deps.length, 2, 'зависимости родитель→ребёнок');

  const park = c.calls.find((q) => /UPDATE tasks SET status = 'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.ok(park, 'родитель припаркован на барьере');
  assert.equal(park.params[2], 'J', 'родитель переведён на узел join (current_stage_key)');

  assert.equal(c.calls.some((q) => /DELETE\s+FROM\s+tasks\b/i.test(q.sql)), false, 'нет DELETE задачи');
});

test('JOIN: все дети DONE → родитель продвигается за join (нет рёбер дальше → DONE)', async () => {
  const c = fakeClient([
    // (1) дети на join — нет.
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    // (2) родитель на join со всеми терминальными детьми.
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, status: 'WAITING_FOR_CHILDREN', current_role_id: 'rJoin', current_stage_key: 'J', data_card: {} }],
    } },
    { re: /SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id/, reply: {
      rowCount: 2, rows: [{ status: 'DONE', data_card: { a: 1 } }, { status: 'DONE', data_card: { b: 2 } }],
    } },
    // граф: у join нет исходящих рёбер → родитель завершается.
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: 0, rows: [] } },
  ]);

  const n = await advanceJoinNodes(c);
  assert.equal(n, 1, 'барьер снят для одного родителя');

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd, 'родитель продвинут');
  assert.equal(upd.params[1], 'DONE', 'нет рёбер за join → DONE');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'TASK_DONE');
  assert.equal(c.calls.some((q) => /DELETE\s+FROM\s+tasks\b/i.test(q.sql)), false, 'нет DELETE');
});

test('JOIN: упавшая ветка → родитель BLOCKED (политика all-DONE-required)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, status: 'WAITING_FOR_CHILDREN', current_role_id: 'rJoin', current_stage_key: 'J', data_card: {} }],
    } },
    { re: /SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id/, reply: {
      rowCount: 2, rows: [{ status: 'DONE', data_card: {} }, { status: 'FAILED', data_card: {} }],
    } },
  ]);

  const n = await advanceJoinNodes(c);
  assert.equal(n, 1);

  const blocked = c.calls.find((q) => /UPDATE tasks SET status = 'BLOCKED'/.test(q.sql));
  assert.ok(blocked, 'упавшая ветка → родитель BLOCKED');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.match(ev.sql, /'BLOCKED'/, 'событие перехода в BLOCKED');
  assert.match(ev.params[2], /join_child_failed/, 'причина — упавшая ветка');
});

// DOC-COMMIT-ON-JOIN-001: граф с узлом Git Integrator ПОСЛЕ join: J (join) → G
// (Git Integrator, COMMIT). Правки Doc Keeper лежат в data_card док-ребёнка —
// advanceJoinNodes агрегирует их и выносит верхним уровнем в событие продвижения
// родителя, чтобы resolveHostTaskContext отдал их пост-join Git Integrator'у.
const POSTJOIN_NODES = [
  { id: 'sJ', stage_key: 'J', kind: 'join',  join_key: null, name: 'Слияние', enabled: true, task_status: null },
  { id: 'sG', stage_key: 'G', kind: 'stage', join_key: null, name: 'Git Integrator (документация)', enabled: true, task_status: 'COMMIT' },
];
const POSTJOIN_ROLES = [
  { stage_id: 'sG', role_id: 'rGI', code: 'GIT_INTEGRATOR', position: 0 },
];
const POSTJOIN_EDGES = [
  { from_key: 'J', to_key: 'G', condition: null, position: 0 },
];

test('JOIN: правки Doc Keeper (changedFiles детей) выносятся в событие продвижения к пост-join Git Integrator', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, status: 'WAITING_FOR_CHILDREN', current_role_id: 'rJoin', current_stage_key: 'J', data_card: {} }],
    } },
    { re: /SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id/, reply: {
      rowCount: 2, rows: [
        // док-ветка: Doc Keeper сдал список отредактированных доков.
        { status: 'DONE', data_card: { changedFiles: ['docs/API_MAP.md', 'docs/ARCHITECTURE.md'] } },
        // git-ветка: код уже закоммичен, changedFiles в карточке нет.
        { status: 'DONE', data_card: {} },
      ],
    } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: POSTJOIN_EDGES.length, rows: POSTJOIN_EDGES } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: POSTJOIN_NODES.length, rows: POSTJOIN_NODES } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: POSTJOIN_ROLES.length, rows: POSTJOIN_ROLES } },
  ]);

  const n = await advanceJoinNodes(c);
  assert.equal(n, 1, 'барьер снят');

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd, 'родитель продвинут');
  assert.equal(upd.params[1], 'COMMIT', 'родитель едет на узел Git Integrator (COMMIT), не DONE');
  assert.equal(upd.params[2], 'rGI', 'роль узла — Git Integrator');
  assert.equal(upd.params[3], 'G', 'current_stage_key → пост-join узел');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'STATUS_CHANGED', 'не DONE — впереди ещё узел');
  const payload = JSON.parse(ev.params[4]);
  assert.deepEqual(payload.changedFiles, ['docs/API_MAP.md', 'docs/ARCHITECTURE.md'],
    'changedFiles детей вынесены верхним уровнем — их подберёт resolveHostTaskContext');
});

test('JOIN: NO_CHANGES доков (пустые changedFiles детей) → в событии нет changedFiles (второго коммита не будет)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, status: 'WAITING_FOR_CHILDREN', current_role_id: 'rJoin', current_stage_key: 'J', data_card: {} }],
    } },
    { re: /SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id/, reply: {
      rowCount: 2, rows: [{ status: 'DONE', data_card: {} }, { status: 'DONE', data_card: {} }],
    } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: POSTJOIN_EDGES.length, rows: POSTJOIN_EDGES } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: POSTJOIN_NODES.length, rows: POSTJOIN_NODES } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: POSTJOIN_ROLES.length, rows: POSTJOIN_ROLES } },
  ]);

  const n = await advanceJoinNodes(c);
  assert.equal(n, 1);

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[3], 'G', 'родитель всё равно проходит через пост-join узел');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  const payload = JSON.parse(ev.params[4]);
  assert.equal(payload.changedFiles, undefined, 'без правок доков changedFiles в событии нет');
});

test('JOIN: changedFiles детей объединяются с дедупом (несколько веток с правками)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1,
      rows: [{ id: PARENT, project_id: PROJ, status: 'WAITING_FOR_CHILDREN', current_role_id: 'rJoin', current_stage_key: 'J', data_card: {} }],
    } },
    { re: /SELECT status::text AS status, data_card FROM tasks WHERE parent_task_id/, reply: {
      rowCount: 2, rows: [
        { status: 'DONE', data_card: { changedFiles: ['docs/API_MAP.md', 'docs/PROJECT_MAP.md'] } },
        { status: 'DONE', data_card: { changedFiles: ['docs/PROJECT_MAP.md', 'docs/ARCHITECTURE.md'] } },
      ],
    } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: POSTJOIN_EDGES.length, rows: POSTJOIN_EDGES } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: POSTJOIN_NODES.length, rows: POSTJOIN_NODES } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: POSTJOIN_ROLES.length, rows: POSTJOIN_ROLES } },
  ]);

  await advanceJoinNodes(c);
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  const payload = JSON.parse(ev.params[4]);
  assert.deepEqual(payload.changedFiles,
    ['docs/API_MAP.md', 'docs/PROJECT_MAP.md', 'docs/ARCHITECTURE.md'],
    'объединение по порядку первого вхождения, PROJECT_MAP.md один раз');
});

// FORK-CHILD-001 — дочерняя задача (сервисная подзадача эпика), доехавшая до fork,
// расщепляется так же, как корневая: раньше `parent_task_id IS NULL` заклинивал
// детей на fork-узле навсегда (Git Integrator не запускался, деливеребл терялся).
test('FORK-CHILD-001: дочерняя задача на fork расщепляется (нет фильтра по parent_task_id)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'fork'/, reply: {
      rowCount: 1,
      rows: [{ id: 'svc-child-1', project_id: PROJ, title: 'Подзадача сервиса', description: 'd', service_id: 'svc1',
               status: 'TESTING', current_role_id: 'rFork', current_stage_key: 'F', data_card: {}, join_key: 'J' }],
    } },
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: 2, rows: EDGES_ROWS } },
    { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: 2, rows: NODES_ROWS } },
    { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: 2, rows: NODE_ROLES } },
    { re: /FROM roles WHERE code = 'JOIN_GATE'/, reply: { rowCount: 1, rows: [{ id: 'rJoin' }] } },
    { re: /INSERT INTO tasks[\s\S]*RETURNING id/, reply: (hits) => ({ rowCount: 1, rows: [{ id: `branch-${hits}` }] }) },
  ]);

  const n = await advanceForkNodes(c);
  assert.equal(n, 1, 'дочерняя задача расщеплена');

  const select = c.calls.find((q) => /kind = 'fork'/.test(q.sql));
  assert.equal(/parent_task_id IS NULL/.test(select.sql), false,
    'выборка fork не ограничена корневыми задачами');
  assert.match(select.sql, /ch\.parent_task_id = t\.id\s+AND ch\.status NOT IN \('DONE','CANCELLED','FAILED'\)/,
    'идемпотентность — по НЕЗАВЕРШЁННЫМ детям (терминальные дети прошлого прохода не заклинивают)');

  const park = c.calls.find((q) => /UPDATE tasks SET status = 'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.ok(park, 'ребёнок припаркован на своём join как fork-родитель своих веток');
});

// FORK-CHILD-001 — шаг (1) join НЕ завершает припаркованного fork-родителя
// (WAITING_FOR_CHILDREN); шаг (2) снимает барьер и для дочерней задачи.
test('FORK-CHILD-001: join шаг(1) исключает WAITING_FOR_CHILDREN; шаг(2) без фильтра корневых', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NOT NULL/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*status = 'WAITING_FOR_CHILDREN'/, reply: { rowCount: 0, rows: [] } },
  ]);
  await advanceJoinNodes(c);

  const step1 = c.calls.find((q) => /parent_task_id IS NOT NULL/.test(q.sql));
  assert.ok(step1, 'шаг (1) выполнен');
  // NEEDS_INPUT (TASK-NEEDS-INPUT-001) исключён здесь по той же причине, что и
  // WAITING_FOR_CHILDREN: ребёнок, стоящий на вопросе к человеку, ещё не отработал,
  // и закрывать его на join нельзя.
  assert.match(step1.sql, /NOT IN \('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT'\)/,
    'припаркованный fork-родитель не завершается шагом (1)');

  const step2 = c.calls.find((q) => /status = 'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.ok(step2, 'шаг (2) выполнен');
  assert.equal(/t\.parent_task_id IS NULL/.test(step2.sql), false,
    'барьер снимается и для дочерней задачи-fork-родителя');
});
