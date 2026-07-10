// DOCS-DEBT-001 — фиксация документационного долга в data_card при мягком проходе
// DOCUMENTATION_AUDITOR/KEEPER. BLOCKED-вердикт этих ролей НЕ блокирует основной
// поток (docForward, reason='docs_blocked_forwarded'), но теперь помечает долг
// (docs_debt.status='open') ради наблюдаемости; обычный успешный форвард той же
// роли гасит долг (status='resolved'). Поведение потока/маршрутизация не меняются.
// Транзакционное ядро сдачи на мини-клиенте pg (первое regex-правило выигрывает),
// по образцу missingOutputsCap.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyReasoningVerdict } from '../src/db.js';

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

// Транзакционные запросы finalizeRole: задача есть, прогон ещё RUNNING (не
// финализирован), следующая роль резолвится, UPDATE/INSERT принимаются.
function finalizeRules() {
  return [
    { re: /SELECT status::text AS status FROM tasks WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'COMMIT' }] } },
    { re: /SELECT status::text AS status FROM agent_runs WHERE id = \$1 FOR UPDATE/, reply: { rowCount: 1, rows: [{ status: 'RUNNING' }] } },
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 1, rows: [{ id: 'role-next' }] } },
    { re: /UPDATE tasks SET/, reply: { rowCount: 1 } },
    { re: /UPDATE agent_runs SET status = \$2/, reply: { rowCount: 1 } },
    { re: /INSERT INTO reviews/, reply: { rowCount: 1 } },
    { re: /INSERT INTO task_events/, reply: { rowCount: 1 } },
  ];
}

const CONTRACT = { outputs: [] };

const claimed = (roleCode) => ({
  id: 't1', title: 'X', description: '', status: 'COMMIT', project_id: 'p1',
  data_card: {}, current_stage_key: null, role_code: roleCode, role_id: 'r-cur',
  agentId: 'a1', agentRunId: 'run1', reworkCount: 0,
});

// data_card мёржится существующим UPDATE tasks (data_card = data_card || $4::jsonb),
// т.е. итоговый cardValues — 4-й параметр (index 3) запроса UPDATE tasks.
function mergedCard(calls) {
  const q = calls.find((x) => /UPDATE tasks SET/.test(x.sql));
  assert.ok(q, 'нет UPDATE tasks');
  return JSON.parse(q.params[3]);
}

test('DOCUMENTATION_AUDITOR: BLOCKED-вердикт → задача идёт вперёд И docs_debt=open с причиной', async () => {
  const c = fakeClient(finalizeRules());
  const res = await applyReasoningVerdict(c, claimed('DOCUMENTATION_AUDITOR'), {
    route: [], contract: CONTRACT,
    verdict: { ok: false, status: 'BLOCKED', summary: 'код разошёлся с документацией', findings: [], fields: {} },
    response: 'x', exchangeId: null, durationMs: null, kpi: null,
  });
  // Поток НЕ заблокирован — мягкий проход вперёд к следующей роли (не BLOCKED).
  assert.equal(res.toStatus, 'COMMIT');
  assert.equal(res.nextRole, 'GIT_INTEGRATOR');
  const card = mergedCard(c.calls);
  assert.ok(card.docs_debt, 'docs_debt записан в data_card');
  assert.equal(card.docs_debt.status, 'open');
  assert.equal(card.docs_debt.role, 'DOCUMENTATION_AUDITOR');
  assert.equal(card.docs_debt.reason, 'код разошёлся с документацией');
  assert.ok(typeof card.docs_debt.at === 'string' && card.docs_debt.at, 'есть отметка времени at');
});

test('DOCUMENTATION_KEEPER: BLOCKED-вердикт → docs_debt=open (тоже мягкий проход)', async () => {
  const c = fakeClient(finalizeRules());
  const res = await applyReasoningVerdict(c, claimed('DOCUMENTATION_KEEPER'), {
    route: [], contract: CONTRACT,
    verdict: { ok: false, status: 'BLOCKED', summary: '', findings: [], fields: {} },
    response: 'x', exchangeId: null, durationMs: null, kpi: null,
  });
  assert.equal(res.toStatus, 'COMMIT');
  const card = mergedCard(c.calls);
  assert.equal(card.docs_debt.status, 'open');
  assert.equal(card.docs_debt.role, 'DOCUMENTATION_KEEPER');
  // summary пуст → причина падает на код решения (docs_blocked_forwarded).
  assert.equal(card.docs_debt.reason, 'docs_blocked_forwarded');
});

test('DOCUMENTATION_KEEPER: обычный успешный FORWARD → docs_debt=resolved (гашение)', async () => {
  const c = fakeClient(finalizeRules());
  await applyReasoningVerdict(c, claimed('DOCUMENTATION_KEEPER'), {
    route: [], contract: CONTRACT,
    verdict: { ok: true, status: 'READY', summary: 'документация доведена', findings: [], fields: {} },
    response: 'x', exchangeId: null, durationMs: null, kpi: null,
  });
  const card = mergedCard(c.calls);
  assert.equal(card.docs_debt.status, 'resolved', 'долг погашен при нормальном форварде');
});

test('не-документационная роль (TASK_REVIEWER) → docs_debt НЕ пишется', async () => {
  const c = fakeClient(finalizeRules());
  await applyReasoningVerdict(c, claimed('TASK_REVIEWER'), {
    route: [], contract: CONTRACT,
    verdict: { ok: true, status: 'APPROVED', summary: 'ок', findings: [], fields: {} },
    response: 'x', exchangeId: null, durationMs: null, kpi: null,
  });
  const card = mergedCard(c.calls);
  assert.equal(card.docs_debt, undefined, 'долг у обычной роли не появляется');
});
