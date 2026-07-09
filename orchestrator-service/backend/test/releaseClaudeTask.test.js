// PROGRAMMER-RELEASE-REASON-001 — тесты releaseClaudeTaskTx: причина (reason)
// освобождения захвата пишется в outcome/error_text прогона и обрезается по длине.
// Мини-клиент pg (как в taskMutations.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseClaudeTaskTx } from '../src/db.js';

function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          const out = typeof rule.reply === 'function' ? rule.reply(params) : rule.reply;
          return out ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Задача реально освобождена из CODING → есть строка с current_role_id.
const releasedRules = () => [
  { re: /UPDATE tasks SET assigned_agent_id = NULL/, reply: { rowCount: 1, rows: [{ id: 'T1', current_role_id: 'rP' }] } },
];

// params UPDATE agent_runs: [id, runStatus, turns, outcome, error_text, role_id]
const findRunUpdate = (c) => c.calls.find((q) => /UPDATE agent_runs/.test(q.sql));

test('releaseClaudeTaskTx: reason → outcome и error_text прогона (FAILED)', async () => {
  const c = fakeClient(releasedRules());
  const res = await releaseClaudeTaskTx(c, 'T1', { reason: 'integrate_conflict: patch failed' });
  assert.equal(res.released, true);
  const upd = findRunUpdate(c);
  assert.ok(upd, 'RUNNING-прогон финализирован');
  assert.equal(upd.params[1], 'FAILED');
  assert.equal(upd.params[3], 'integrate_conflict: patch failed'); // outcome = reason
  assert.equal(upd.params[4], 'programmer_released: integrate_conflict: patch failed'); // error_text
});

test('releaseClaudeTaskTx: agent_timeout → TIMEOUT + причина в outcome', async () => {
  const c = fakeClient(releasedRules());
  await releaseClaudeTaskTx(c, 'T1', { reason: 'agent_timeout' });
  const upd = findRunUpdate(c);
  assert.equal(upd.params[1], 'TIMEOUT');
  assert.equal(upd.params[3], 'agent_timeout');
  assert.equal(upd.params[4], 'programmer_released: agent_timeout');
});

test('releaseClaudeTaskTx: без reason → outcome released (обратная совместимость)', async () => {
  const c = fakeClient(releasedRules());
  await releaseClaudeTaskTx(c, 'T1', {});
  const upd = findRunUpdate(c);
  assert.equal(upd.params[3], 'released');
  assert.equal(upd.params[4], 'programmer_released: released');
});

test('releaseClaudeTaskTx: длинный reason обрезается до 500 символов', async () => {
  const c = fakeClient(releasedRules());
  await releaseClaudeTaskTx(c, 'T1', { reason: 'x'.repeat(2000) });
  const upd = findRunUpdate(c);
  assert.equal(upd.params[3].length, 500, 'outcome обрезан до 500');
  assert.ok(upd.params[4].length <= 500, 'error_text не длиннее 500');
  assert.ok(upd.params[4].startsWith('programmer_released: '), 'префикс сохранён');
});

test('releaseClaudeTaskTx: max_turns_exceeded → KPI-событие + turns из meta', async () => {
  const c = fakeClient(releasedRules());
  await releaseClaudeTaskTx(c, 'T1', { reason: 'max_turns_exceeded', meta: { numTurns: 100, maxTurns: 100 } });
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql));
  assert.ok(ev, 'KPI-событие записано');
  const payload = JSON.parse(ev.params[2]);
  assert.equal(payload.kind, 'programmer_limit_exceeded');
  assert.equal(payload.numTurns, 100);
  const upd = findRunUpdate(c);
  assert.equal(upd.params[2], 100, 'turns взяты из meta.numTurns');
  assert.equal(upd.params[3], 'max_turns_exceeded');
});

// PROGRAMMER-CROSS-SERVICE-PREFLIGHT-001: явный кросс-сервисный блокер → задача
// уводится в BLOCKED (а не остаётся в CODING на повтор) с точной причиной.
test('releaseClaudeTaskTx: blockerKind=cross_service → BLOCKED + TASK_BLOCKED + crossServiceBlocked', async () => {
  const c = fakeClient([
    ...releasedRules(),
    { re: /UPDATE tasks SET status = 'BLOCKED'/, reply: { rowCount: 1, rows: [{ id: 'T1' }] } },
  ]);
  const res = await releaseClaudeTaskTx(c, 'T1', {
    reason: 'agent_reported_failure: нужен proto Chat_Service',
    meta: { blockerKind: 'cross_service', blockedByService: 'Chat_Service' },
  });
  assert.equal(res.released, true);
  assert.equal(res.crossServiceBlocked, true, 'задача уведена в BLOCKED');
  const blockUpd = c.calls.find((q) => /UPDATE tasks SET status = 'BLOCKED'/.test(q.sql));
  assert.ok(blockUpd, 'выполнен перевод в BLOCKED');
  const ev = c.calls.find((q) => /INSERT INTO task_events/.test(q.sql) && /TASK_BLOCKED/.test(q.sql));
  assert.ok(ev, 'записано TASK_BLOCKED-событие');
  const payload = JSON.parse(ev.params[2]);
  assert.equal(payload.reason, 'cross_service_dependency');
  assert.equal(payload.blockedByService, 'Chat_Service');
  // Прогон всё равно финализирован FAILED (не теряем KPI).
  assert.equal(findRunUpdate(c).params[1], 'FAILED');
});

test('releaseClaudeTaskTx: обычный провал (без blockerKind) не уводит в BLOCKED', async () => {
  const c = fakeClient(releasedRules());
  const res = await releaseClaudeTaskTx(c, 'T1', { reason: 'agent_reported_failure: не смог' });
  assert.equal(res.crossServiceBlocked, false);
  assert.equal(c.calls.some((q) => /UPDATE tasks SET status = 'BLOCKED'/.test(q.sql)), false,
    'обычный провал остаётся в CODING (повтор по backoff)');
});

test('releaseClaudeTaskTx: не в CODING (0 строк) → released=false, прогон не трогаем', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks SET assigned_agent_id = NULL/, reply: { rowCount: 0, rows: [] } },
  ]);
  const res = await releaseClaudeTaskTx(c, 'T1', { reason: 'whatever' });
  assert.equal(res.released, false);
  assert.equal(c.calls.some((q) => /UPDATE agent_runs/.test(q.sql)), false, 'нет финализации прогона');
});

test('releaseClaudeTaskTx: пустой taskId → 422 taskId_required', async () => {
  const c = fakeClient([]);
  await assert.rejects(() => releaseClaudeTaskTx(c, '   ', {}), (e) => e.statusCode === 422 && /taskId_required/.test(e.message));
});
