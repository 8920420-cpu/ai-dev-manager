// TASK-PRIORITY-SCALE-001 — тесты приоритетов задач: шкала SMALLINT 0..3 (меньше =
// важнее), серверный форс 0 для проекта оркестратора, нормализация пользовательского
// приоритета, инверсия сортировки очередей (priority ASC, FIFO по created_at) и
// валидация смены приоритета из карточки. Мини-клиент pg — как в taskMutations.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isOrchestratorProject,
  normalizeClientPriority,
  computeTaskPriority,
  setTaskPriorityTx,
  claimNextClaudeTaskTx,
} from '../src/db.js';

function fakeClient(rules = []) {
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

// --- Helper: определение проекта оркестратора --------------------------------

test('isOrchestratorProject: code=PROJECT → true', () => {
  assert.equal(isOrchestratorProject({ code: 'PROJECT', root_path: '/x' }), true);
  assert.equal(isOrchestratorProject({ code: 'project', root_path: '/x' }), true); // регистронезависимо
});

test('isOrchestratorProject: root_path содержит ai-dev-manager → true', () => {
  assert.equal(isOrchestratorProject({ code: 'OTHER', root_path: '/home/user/ai-dev-manager' }), true);
  assert.equal(isOrchestratorProject({ code: 'OTHER', root_path: 'C:/repos/AI-Dev-Manager/x' }), true);
});

test('isOrchestratorProject: обычный проект / null → false', () => {
  assert.equal(isOrchestratorProject({ code: 'CRM', root_path: '/srv/crm' }), false);
  assert.equal(isOrchestratorProject(null), false);
  assert.equal(isOrchestratorProject(undefined), false);
});

test('isOrchestratorProject: код переопределяется env ORCHESTRATOR_PROJECT_CODE', () => {
  const prev = process.env.ORCHESTRATOR_PROJECT_CODE;
  process.env.ORCHESTRATOR_PROJECT_CODE = 'AIDEV';
  try {
    assert.equal(isOrchestratorProject({ code: 'AIDEV', root_path: '/x' }), true);
    assert.equal(isOrchestratorProject({ code: 'PROJECT', root_path: '/x' }), false); // теперь не дефолт
  } finally {
    if (prev === undefined) delete process.env.ORCHESTRATOR_PROJECT_CODE;
    else process.env.ORCHESTRATOR_PROJECT_CODE = prev;
  }
});

// --- Helper: нормализация пользовательского приоритета -----------------------

test('normalizeClientPriority: 0/отрицательное → 1 (клиент не ставит 0)', () => {
  assert.equal(normalizeClientPriority(0), 1);
  assert.equal(normalizeClientPriority(-5), 1);
});

test('normalizeClientPriority: >3 клампится к 3, 1..3 без изменений', () => {
  assert.equal(normalizeClientPriority(5), 3);
  assert.equal(normalizeClientPriority(1), 1);
  assert.equal(normalizeClientPriority(2), 2);
  assert.equal(normalizeClientPriority(3), 3);
});

test('normalizeClientPriority: пусто/мусор → дефолт 2', () => {
  assert.equal(normalizeClientPriority(null), 2);
  assert.equal(normalizeClientPriority(undefined), 2);
  assert.equal(normalizeClientPriority(''), 2);
  assert.equal(normalizeClientPriority('abc'), 2);
  assert.equal(normalizeClientPriority('2'), 2); // числовая строка парсится
});

// --- Helper: итоговый приоритет (форс оркестратора) --------------------------

test('computeTaskPriority: проект оркестратора → всегда 0 (форс сервера)', () => {
  const orch = { code: 'PROJECT', root_path: '/ai-dev-manager' };
  assert.equal(computeTaskPriority(orch, 1), 0);
  assert.equal(computeTaskPriority(orch, 3), 0);
  assert.equal(computeTaskPriority(orch, undefined), 0);
  assert.equal(computeTaskPriority(orch, 0), 0);
});

test('computeTaskPriority: не-оркестратор — priority=0 нормализуется к 1', () => {
  const crm = { code: 'CRM', root_path: '/srv/crm' };
  assert.equal(computeTaskPriority(crm, 0), 1);
});

test('computeTaskPriority: не-оркестратор — дефолт 2, clamp 1..3', () => {
  const crm = { code: 'CRM', root_path: '/srv/crm' };
  assert.equal(computeTaskPriority(crm, undefined), 2);
  assert.equal(computeTaskPriority(crm, 1), 1);
  assert.equal(computeTaskPriority(crm, 9), 3);
});

test('computeTaskPriority: беспроектная задача (null) → пользовательская шкала, не 0', () => {
  assert.equal(computeTaskPriority(null, undefined), 2);
  assert.equal(computeTaskPriority(null, 0), 1);
});

// --- Инверсия сортировки очереди: priority ASC, FIFO по created_at ASC -------

const SELECT_PRIO_RE = /SELECT t\.id, t\.priority[\s\S]*FOR UPDATE OF t/;

test('claimNextClaudeTaskTx: очередь программиста сортирует priority ASC, created_at ASC', async () => {
  // orchestrator_enabled: пустой ответ app_settings → readAppSetting отдаёт дефолт true.
  const c = fakeClient([
    { re: /WITH picked AS/, reply: { rowCount: 0, rows: [] } },
  ]);
  await claimNextClaudeTaskTx(c);
  const picked = c.calls.find((q) => /WITH picked AS/.test(q.sql));
  assert.ok(picked, 'запрос захвата выполнен');
  // 0 раньше 1 раньше 2 раньше 3; при равном приоритете — FIFO (created_at ASC).
  assert.ok(/ORDER BY t\.priority ASC, t\.created_at ASC/.test(picked.sql),
    'priority ASC (меньше = важнее) + FIFO по created_at ASC');
  assert.ok(!/priority DESC/.test(picked.sql), 'старого DESC-порядка не осталось');
});

test('исходник db.js: все claim-выборки перевёрнуты на priority ASC, created_at ASC', async () => {
  const src = await readFile(new URL('../src/db.js', import.meta.url), 'utf8');
  const asc = (src.match(/ORDER BY t\.priority ASC, t\.created_at ASC/g) || []).length;
  // Три пути выдачи работы: claimNextClaudeTaskTx, claimNextHostTask, claimLlmRoleTask.
  assert.ok(asc >= 3, `ожидалось ≥3 перевёрнутых claim-сортировки, найдено ${asc}`);
  assert.ok(!/ORDER BY t\.priority DESC/.test(src), 'ни одной claim-сортировки priority DESC не осталось');
});

// --- Смена приоритета из карточки: валидация (setTaskPriorityTx) -------------

function priorityClient(row) {
  return fakeClient([{ re: SELECT_PRIO_RE, reply: { rowCount: 1, rows: [row] } }]);
}

test('setTaskPriority: не-оркестраторной задаче нельзя задать 0 → 422', async () => {
  const c = priorityClient({ id: 't1', priority: 2, project_code: 'CRM', root_path: '/srv/crm' });
  await assert.rejects(
    () => setTaskPriorityTx(c, 't1', 0),
    (e) => e.statusCode === 422 && /priority_zero_orchestrator_only/.test(e.message),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks SET priority/.test(q.sql)), false, 'приоритет не изменён');
  assert.ok(c.calls.some((q) => /ROLLBACK/.test(q.sql)));
});

test('setTaskPriority: оркестраторную нельзя понизить ниже 0 (задать 1..3) → 422', async () => {
  const c = priorityClient({ id: 't1', priority: 0, project_code: 'PROJECT', root_path: '/ai-dev-manager' });
  await assert.rejects(
    () => setTaskPriorityTx(c, 't1', 2),
    (e) => e.statusCode === 422 && /priority_orchestrator_forced_zero/.test(e.message),
  );
  assert.equal(c.calls.some((q) => /UPDATE tasks SET priority/.test(q.sql)), false);
});

test('setTaskPriority: оркестраторной можно подтвердить 0 (idempotent, без UPDATE)', async () => {
  const c = priorityClient({ id: 't1', priority: 0, project_code: 'PROJECT', root_path: '/ai-dev-manager' });
  const res = await setTaskPriorityTx(c, 't1', 0);
  assert.equal(res.updated, true);
  assert.equal(res.priority, 0);
  assert.equal(res.changed, false, 'значение не менялось');
  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)));
});

test('setTaskPriority: обычной задаче можно 1..3 → UPDATE + событие', async () => {
  const c = priorityClient({ id: 't1', priority: 2, project_code: 'CRM', root_path: '/srv/crm' });
  const res = await setTaskPriorityTx(c, 't1', 1);
  assert.equal(res.updated, true);
  assert.equal(res.priority, 1);
  assert.equal(res.changed, true);
  const upd = c.calls.find((q) => /UPDATE tasks SET priority = \$2::smallint/.test(q.sql));
  assert.ok(upd, 'приоритет обновлён');
  assert.equal(upd.params[1], 1);
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.ok(ev, 'записано audit-событие смены приоритета');
  const payload = JSON.parse(ev.params[1]);
  assert.equal(payload.source, 'manual-priority');
  assert.equal(payload.fromPriority, 2);
  assert.equal(payload.toPriority, 1);
});

test('setTaskPriority: значение вне диапазона 0..3 → 422 priority_out_of_range', async () => {
  const c = fakeClient([]);
  await assert.rejects(
    () => setTaskPriorityTx(c, 't1', 5),
    (e) => e.statusCode === 422 && /priority_out_of_range/.test(e.message),
  );
  // Транзакцию даже не открываем.
  assert.equal(c.calls.some((q) => /BEGIN/.test(q.sql)), false);
});

test('setTaskPriority: пустое значение → 422 priority_required', async () => {
  const c = fakeClient([]);
  await assert.rejects(
    () => setTaskPriorityTx(c, 't1', null),
    (e) => e.statusCode === 422 && /priority_required/.test(e.message),
  );
});

test('setTaskPriority: несуществующая задача → 404 task_not_found', async () => {
  const c = fakeClient([{ re: SELECT_PRIO_RE, reply: { rowCount: 0, rows: [] } }]);
  await assert.rejects(
    () => setTaskPriorityTx(c, 'nope', 2),
    (e) => e.statusCode === 404 && /task_not_found/.test(e.message),
  );
});
