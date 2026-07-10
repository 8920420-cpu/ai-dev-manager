import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceStuckDocumentationBranches } from '../src/db.js';

// DOC-BRANCH-LIVENESS-001: подметатель, продвигающий «мёртвую» документационную
// fork-ветвь на узел вперёд к join, чтобы она не держала родителя в WAITING_FOR_CHILDREN.

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

// Граф документационной ветви: doc-auditor (dA) → doc-keeper (dK) → join (J).
const NODES_ROWS = [
  { id: 'sA', stage_key: 'dA', kind: 'stage', join_key: null, name: 'Аудит', enabled: true, task_status: 'COMMIT' },
  { id: 'sK', stage_key: 'dK', kind: 'stage', join_key: null, name: 'Документы', enabled: true, task_status: 'COMMIT' },
  { id: 'sJ', stage_key: 'J', kind: 'join', join_key: null, name: 'Слияние', enabled: true, task_status: null },
];
const NODE_ROLES = [
  { stage_id: 'sA', role_id: 'rA', code: 'DOCUMENTATION_AUDITOR', position: 0 },
  { stage_id: 'sK', role_id: 'rK', code: 'DOCUMENTATION_KEEPER', position: 0 },
];
const EDGES_ROWS = [
  { from_key: 'dA', to_key: 'dK', condition: null, position: 0 },
  { from_key: 'dK', to_key: 'J', condition: null, position: 1 },
];

const graphRules = () => [
  { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: EDGES_ROWS.length, rows: EDGES_ROWS } },
  { re: /FROM project_stages WHERE project_id = \$1 ORDER BY position/, reply: { rowCount: NODES_ROWS.length, rows: NODES_ROWS } },
  { re: /FROM project_stage_roles psr JOIN roles/, reply: { rowCount: NODE_ROLES.length, rows: NODE_ROLES } },
  // UPDATE tasks фиксирует переход — вернуть rowCount:1, иначе moved не считается.
  { re: /UPDATE tasks SET status = \$2::task_status/, reply: { rowCount: 1 } },
];

test('документационный ребёнок в BLOCKED → graph-forward к Keeper (не остаётся BLOCKED)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: {
      rowCount: 1,
      rows: [{ id: 'child-1', project_id: 'p1', status: 'BLOCKED', current_role_id: 'rA',
               current_stage_key: 'dA', role_code: 'DOCUMENTATION_AUDITOR', bad_runs: 0 }],
    } },
    ...graphRules(),
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rK' }] } },
  ]);

  const n = await advanceStuckDocumentationBranches(c);
  assert.equal(n, 1, 'ветвь продвинута');

  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.ok(upd, 'задача обновлена');
  assert.equal(upd.params[1], 'COMMIT', 'ветвь ожила в COMMIT (не BLOCKED)');
  assert.equal(upd.params[2], 'rK', 'роль → Documentation Keeper');
  assert.equal(upd.params[3], 'dK', 'узел → следующий (Keeper)');

  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.match(ev.params[5], /documentation_branch_advanced/);
});

test('исчерпание попыток (bad_runs>=maxAttempts) на здоровом статусе → тоже forward', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: {
      rowCount: 1,
      rows: [{ id: 'child-2', project_id: 'p1', status: 'COMMIT', current_role_id: 'rA',
               current_stage_key: 'dA', role_code: 'DOCUMENTATION_AUDITOR', bad_runs: 3 }],
    } },
    ...graphRules(),
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rK' }] } },
  ]);
  const n = await advanceStuckDocumentationBranches(c, 3);
  assert.equal(n, 1, 'исчерпавшая попытки ветвь продвинута');
});

test('здоровая ветвь (COMMIT, попыток мало, свежая) НЕ трогается', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: {
      rowCount: 1,
      rows: [{ id: 'child-3', project_id: 'p1', status: 'COMMIT', current_role_id: 'rA',
               current_stage_key: 'dA', role_code: 'DOCUMENTATION_AUDITOR', bad_runs: 1, age_ms: 1000 }],
    } },
    ...graphRules(),
  ]);
  const n = await advanceStuckDocumentationBranches(c, 3, 60 * 60_000);
  assert.equal(n, 0, 'здоровую документационную ветвь не трогаем — пусть выполняется');
  assert.equal(c.calls.some((q) => /UPDATE tasks/.test(q.sql)), false);
});

test('мёртвый движок: ветвь висит дольше maxAge (bad_runs=0) → всё равно forward', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: {
      rowCount: 1,
      rows: [{ id: 'child-5', project_id: 'p1', status: 'COMMIT', current_role_id: 'rA',
               current_stage_key: 'dA', role_code: 'DOCUMENTATION_AUDITOR', bad_runs: 0, age_ms: 2 * 60 * 60_000 }],
    } },
    ...graphRules(),
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rK' }] } },
  ]);
  const n = await advanceStuckDocumentationBranches(c, 3, 60 * 60_000);
  assert.equal(n, 1, 'зависшая дольше часа ветвь продвинута, даже без единого прогона');
});

test('осиротевший ребёнок с NULL stage_key восстанавливает узел по роли и идёт вперёд', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: {
      rowCount: 1,
      rows: [{ id: 'child-4', project_id: 'p1', status: 'COMMIT', current_role_id: 'rA',
               current_stage_key: null, role_code: 'DOCUMENTATION_AUDITOR', bad_runs: 5 }],
    } },
    ...graphRules(),
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'rK' }] } },
  ]);
  const n = await advanceStuckDocumentationBranches(c, 3);
  assert.equal(n, 1, 'осиротевшая ветвь восстановлена и продвинута');
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[3], 'dK', 'восстановил узел аудитора и шагнул к Keeper');
});

test('не документационные роли не затрагиваются (пустой результат → 0)', async () => {
  const c = fakeClient([
    { re: /FROM tasks t JOIN roles r ON r\.id = t\.current_role_id[\s\S]*parent_task_id IS NOT NULL[\s\S]*r\.code = ANY/, reply: { rowCount: 0, rows: [] } },
  ]);
  const n = await advanceStuckDocumentationBranches(c);
  assert.equal(n, 0);
  assert.equal(c.calls.some((q) => /DELETE\s+FROM\s+tasks/i.test(q.sql)), false, 'никаких DELETE');
});
