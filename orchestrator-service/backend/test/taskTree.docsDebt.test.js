// DOCS-DEBT-001 — выдача документационного долга в дереве задач (buildTaskTree /
// stripNode). Непогашенный (status==='open') docs_debt из data_card прокидывается
// в узел (docsDebt) для задач и подзадач; погашенный/отсутствующий/невалидный — нет.
// Формат ответа /api/tasks/tree не меняется. Реальный pg не используется — строки
// projects/tasks передаём прямо аргументами в чистую функцию buildTaskTree
// (стиль как в test/docsDebt.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskTree } from '../src/taskTree.js';

const project = (over = {}) => ({ id: 'p1', name: 'Проект', code: 'PRJ', ...over });
const task = (over = {}) => ({
  id: 't1',
  project_id: 'p1',
  parent_task_id: null,
  title: 'Задача',
  status: 'CODING',
  priority: 'P2',
  data_card: null,
  ...over,
});
const openDebt = {
  role: 'DOCUMENTATION_AUDITOR',
  reason: 'код разошёлся с документацией',
  status: 'open',
  at: '2026-07-09T00:00:00.000Z',
};

test('(1) top-level задача с docs_debt open → узел содержит docsDebt с причиной', () => {
  const { projects } = buildTaskTree(
    [project()],
    [task({ data_card: { docs_debt: openDebt } })],
  );
  const node = projects[0].tasks.find((t) => t.id === 't1');
  assert.ok(node, 'задача присутствует в дереве');
  assert.ok(node.docsDebt, 'docsDebt проброшен в узел');
  assert.equal(node.docsDebt.role, 'DOCUMENTATION_AUDITOR');
  assert.equal(node.docsDebt.reason, 'код разошёлся с документацией');
  assert.equal(node.docsDebt.status, 'open');
});

test('(2) docs_debt status=resolved → у узла НЕТ поля docsDebt (undefined)', () => {
  const { projects } = buildTaskTree(
    [project()],
    [task({ data_card: { docs_debt: { ...openDebt, status: 'resolved' } } })],
  );
  const node = projects[0].tasks[0];
  assert.equal('docsDebt' in node, false, 'погашенный долг не выставляется');
  assert.equal(node.docsDebt, undefined);
});

test('(3) нет docs_debt / data_card=null / docs_debt не объект → docsDebt отсутствует', () => {
  const { projects } = buildTaskTree(
    [project()],
    [
      task({ id: 't1', data_card: { other: 1 } }), // data_card без docs_debt
      task({ id: 't2', data_card: null }), // data_card = null
      task({ id: 't3', data_card: { docs_debt: 'nope' } }), // docs_debt не объект
    ],
  );
  const byId = new Map(projects[0].tasks.map((t) => [t.id, t]));
  for (const id of ['t1', 't2', 't3']) {
    const node = byId.get(id);
    assert.ok(node, `узел ${id} присутствует`);
    assert.equal(node.docsDebt, undefined, `${id}: docsDebt отсутствует`);
  }
});

test('(4) подзадача с open docs_debt → долг проброшен в tasks[].subtasks[].docsDebt', () => {
  const parent = task({ id: 't1', parent_task_id: null, title: 'Родитель' });
  const child = task({
    id: 't2',
    parent_task_id: 't1',
    title: 'Подзадача',
    data_card: { docs_debt: openDebt },
  });
  const { projects } = buildTaskTree([project()], [parent, child]);
  const top = projects[0].tasks.find((t) => t.id === 't1');
  assert.ok(top, 'родительская задача — на верхнем уровне');
  const sub = top.subtasks.find((s) => s.id === 't2');
  assert.ok(sub, 'подзадача попала в subtasks');
  assert.ok(sub.docsDebt, 'долг подзадачи проброшен');
  assert.equal(sub.docsDebt.status, 'open');
  assert.equal(sub.docsDebt.role, 'DOCUMENTATION_AUDITOR');
  assert.equal(sub.docsDebt.reason, 'код разошёлся с документацией');
});
