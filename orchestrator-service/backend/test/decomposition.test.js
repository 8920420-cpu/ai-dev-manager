import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWorkItems,
  materializeDecomposition,
  advanceDecompositionParents,
  acceptScannerCompletionTx,
  normalizeScannerCompletion,
} from '../src/db.js';

// Мини-клиент pg (как в forkJoin.test.js): отвечает по первому regex-правилу.
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

// --- normalizeWorkItems (чистая функция) ------------------------------------

test('normalizeWorkItems: берёт work_items как есть, чистит пустые файлы', () => {
  const card = {
    work_items: [
      { serviceCode: 'SvcA', title: 'A', files: [{ path: 'a.js', what: 'x' }, { path: '', what: 'нет пути' }] },
      { serviceCode: '', files: [] }, // без сервиса — отбрасывается
    ],
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 1);
  assert.equal(out[0].serviceCode, 'SvcA');
  assert.equal(out[0].files.length, 1, 'файл без path отброшен');
});

test('normalizeWorkItems: фолбэк из affected_files с группировкой по сервису', () => {
  const card = {
    affected_files: [
      { serviceCode: 'SvcA', path: 'a.js', what: 'x' },
      { serviceCode: 'SvcA', path: 'b.js', what: 'y' },
      { serviceCode: 'SvcB', path: 'c.js', what: 'z' },
    ],
  };
  const out = normalizeWorkItems(card);
  assert.equal(out.length, 2, 'два сервиса');
  const a = out.find((i) => i.serviceCode === 'SvcA');
  assert.equal(a.files.length, 2);
});

// --- materializeDecomposition -----------------------------------------------

function decomposerClaimed() {
  return {
    id: 'epic1', project_id: 'p1', description: 'd', data_card: {},
    role_code: 'DECOMPOSER', role_id: 'rD', agentRunId: 'run1', status: 'DECOMPOSITION',
    current_stage_key: null,
  };
}

test('materializeDecomposition: 2 сервиса → 2 задачи-на-сервис + 3 подзадачи, эпик паркуется', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 2, rows: [
      { id: 'sidA', service_code: 'SvcA' }, { id: 'sidB', service_code: 'SvcB' },
    ] } },
    { re: /FROM roles WHERE code = 'PROGRAMMER'/, reply: { rowCount: 1, rows: [{ id: 'rProg' }] } },
    { re: /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/, reply: (h) => ({ rowCount: 1, rows: [{ id: `l1-${h}` }] }) },
  ]);

  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  // work_items с кодами в нижнем регистре — проверяем регистронезависимый резолв.
  const cardValues = { work_items: [
    { serviceCode: 'svca', title: 'A', files: [{ path: 'a.js', what: 'x' }, { path: 'b.js', what: 'y' }] },
    { serviceCode: 'svcb', title: 'B', files: [{ path: 'c.js', what: 'z' }] },
  ] };

  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });

  assert.equal(res.toStatus, 'WAITING_FOR_CHILDREN');
  assert.equal(res.services, 2);
  assert.equal(res.subtasks, 3);

  const svcInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'service'[\s\S]*RETURNING id/.test(q.sql));
  assert.equal(svcInserts.length, 2, 'две задачи-на-сервис');
  const subInserts = c.calls.filter((q) => /INSERT INTO tasks[\s\S]*'subtask'/.test(q.sql));
  assert.equal(subInserts.length, 3, 'три подзадачи-на-файл');
  const deps = c.calls.filter((q) => /INSERT INTO task_dependencies/.test(q.sql));
  assert.equal(deps.length, 2, 'зависимости эпик→сервис');
  assert.ok(c.calls.some((q) => /UPDATE tasks SET task_kind = 'epic'/.test(q.sql)), 'эпик помечен и припаркован');
  assert.ok(c.calls.some((q) => /UPDATE agent_runs SET status = 'SUCCESS'/.test(q.sql)), 'прогон декомпозитора успешен');
});

test('materializeDecomposition: ни одного зарегистрированного сервиса → эпик BLOCKED', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM services WHERE project_id/, reply: { rowCount: 0, rows: [] } },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  const cardValues = { work_items: [{ serviceCode: 'Unknown', files: [{ path: 'x.js', what: 'y' }] }] };

  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' }, cardValues, route: [],
  });

  assert.equal(res.toStatus, 'BLOCKED');
  assert.equal(res.reason, 'decomposition_no_services');
  assert.ok(c.calls.some((q) => /UPDATE tasks SET status = 'BLOCKED'/.test(q.sql)));
  assert.ok(c.calls.some((q) => /UPDATE agent_runs SET status = 'FAILED'/.test(q.sql)));
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false, 'детей не создаём');
});

test('materializeDecomposition: эпик уже расщеплён → идемпотентно, без дублей', async () => {
  const c = fakeClient([
    { re: /FROM tasks WHERE parent_task_id = \$1 LIMIT 1/, reply: { rowCount: 1, rows: [{ '?column?': 1 }] } },
  ]);
  const verdict = { status: 'READY', summary: 's', findings: [], ok: true };
  const res = await materializeDecomposition(c, decomposerClaimed(), {
    verdict, response: '', exchangeId: null, durationMs: 1, decision: { outcome: 'FORWARD' },
    cardValues: { work_items: [] }, route: [],
  });
  assert.equal(res.reason, 'already_decomposed');
  assert.equal(c.calls.some((q) => /INSERT INTO tasks/.test(q.sql)), false);
});

// --- advanceDecompositionParents (роллап эпиков) ----------------------------

test('advanceDecompositionParents: все сервисы DONE → эпик DONE', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD' },
    ] } },
    { re: /task_kind = 'service' AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 0 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'DONE');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.equal(ev.params[1], 'TASK_DONE', 'событие завершения эпика');
});

test('advanceDecompositionParents: упавший сервис → эпик BLOCKED', async () => {
  const c = fakeClient([
    { re: /FROM tasks t\s+WHERE t.task_kind = 'epic'/, reply: { rowCount: 1, rows: [
      { id: 'epic1', status: 'WAITING_FOR_CHILDREN', current_role_id: 'rD' },
    ] } },
    { re: /task_kind = 'service' AND status IN \('BLOCKED','FAILED'\)/, reply: { rowCount: 1, rows: [{ n: 1 }] } },
  ]);
  const n = await advanceDecompositionParents(c);
  assert.equal(n, 1);
  const upd = c.calls.find((q) => /UPDATE tasks SET status = \$2::task_status/.test(q.sql));
  assert.equal(upd.params[1], 'BLOCKED');
});

// --- acceptScannerCompletionTx: сдача подзадачи -----------------------------

function subtaskCompletionRules(openSubtasks) {
  return [
    { re: /FROM projects\s+WHERE code/, reply: { rowCount: 1, rows: [{ id: 'p1', code: 'PROJ' }] } },
    { re: /reviewer_role_id/, reply: { rowCount: 1, rows: [{
      id: '11111111-1111-4111-8111-111111111111', status: 'CODING', project_id: 'p1', project_code: 'PROJ',
      service_code: 'SvcA', reviewer_role_id: 'rRev', current_role_id: 'rProg', current_role_code: 'PROGRAMMER',
      task_kind: 'subtask', parent_task_id: 'L1',
    }] } },
    { re: /INSERT INTO scanner_dispatches/, reply: { rowCount: 1, rows: [{ id: 'disp1' }] } },
    { re: /to_regclass\('public\.role_fields'\)/, reply: { rowCount: 1, rows: [{ t: null }] } },
    { re: /count\(\*\)::int AS n FROM tasks\s+WHERE parent_task_id = \$1 AND task_kind = 'subtask'/,
      reply: { rowCount: 1, rows: [{ n: openSubtasks }] } },
    { re: /UPDATE tasks SET status = \$2::task_status, current_role_id = \$3, assigned_agent_id = NULL\s+WHERE id = \$1 AND status = 'WAITING_FOR_CHILDREN'/,
      reply: { rowCount: 1, rows: [{ status: 'WAITING_FOR_CHILDREN' }] } },
  ];
}

const SUBTASK_INPUT = {
  taskId: '11111111-1111-4111-8111-111111111111', completionKey: 'k1', project: 'PROJ', service: 'SvcA',
  title: 't', sourceDocument: 'doc', result: 'готово', changedFiles: ['a.js'],
};

test('acceptScannerCompletionTx: подзадача сдана, остались сёстры → родитель НЕ промоутится', async () => {
  const c = fakeClient(subtaskCompletionRules(2));
  const res = await acceptScannerCompletionTx(c, normalizeScannerCompletion(SUBTASK_INPUT));
  assert.equal(res.kind, 'subtask');
  assert.equal(res.parentPromoted, false);
  assert.equal(res.nextRole, null);
  assert.ok(c.calls.some((q) => /UPDATE tasks SET status = 'DONE'/.test(q.sql)), 'подзадача в DONE');
  assert.equal(
    c.calls.some((q) => /status = 'WAITING_FOR_CHILDREN'/.test(q.sql) && /UPDATE tasks/.test(q.sql)),
    false, 'родителя не трогаем',
  );
});

test('acceptScannerCompletionTx: последняя подзадача → родитель уходит в REVIEW/TASK_REVIEWER', async () => {
  const c = fakeClient(subtaskCompletionRules(0));
  const res = await acceptScannerCompletionTx(c, normalizeScannerCompletion(SUBTASK_INPUT));
  assert.equal(res.kind, 'subtask');
  assert.equal(res.parentPromoted, true);
  assert.equal(res.nextRole, 'TASK_REVIEWER');
  const promote = c.calls.find((q) => /WHERE id = \$1 AND status = 'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.ok(promote, 'родитель промоутится');
  assert.equal(promote.params[1], 'REVIEW', 'в статус REVIEW');
});
