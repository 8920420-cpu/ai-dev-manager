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
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NULL/, reply: {
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
    { re: /FROM tasks t\s+JOIN project_stages ps[\s\S]*kind = 'join'[\s\S]*parent_task_id IS NULL/, reply: {
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
