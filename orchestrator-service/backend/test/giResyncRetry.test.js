import test from 'node:test';
import assert from 'node:assert/strict';
import { retryGiBlockedForResync } from '../src/db.js';

// Мини-клиент pg: отвечает по первому regex-правилу (как в decomposition.test.js).
function fakeClient(rules) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      for (const rule of rules) {
        if (rule.re.test(sql)) {
          rule.hits = (rule.hits ?? 0) + 1;
          return (typeof rule.reply === 'function' ? rule.reply(rule.hits, params) : rule.reply) ?? { rows: [], rowCount: 0 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// GI-RESYNC-RETRY-001 — однократный авто-ретрай GI-блока + переоткрытие child-driven предков.

test('retryGiBlockedForResync: ретраит GI-блок (BLOCKED→COMMIT) и переоткрывает предка', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks t[\s\S]*?SET status = 'COMMIT'/, reply: {
      rowCount: 1, rows: [{ id: 'gi1', current_role_id: 'rGI', reason: 'cherry_pick_failed' }] } },
    { re: /UPDATE tasks p[\s\S]*?SET status = 'WAITING_FOR_CHILDREN'/, reply: {
      rowCount: 1, rows: [{ id: 'parent1' }] } },
  ]);
  const res = await retryGiBlockedForResync(c);
  assert.deepEqual(res, { retried: 1, reopened: 1 });

  const commitEv = c.calls.filter((q) => /INSERT INTO task_events/.test(q.sql) && /'COMMIT'/.test(q.sql));
  assert.equal(commitEv.length, 1, 'событие BLOCKED→COMMIT ретрая');
  assert.equal(JSON.parse(commitEv[0].params[2]).reason, 'gi_resync_retry');
  assert.equal(JSON.parse(commitEv[0].params[2]).from, 'cherry_pick_failed');

  const reopenEv = c.calls.filter((q) => /INSERT INTO task_events/.test(q.sql) && /'WAITING_FOR_CHILDREN'/.test(q.sql));
  assert.equal(reopenEv.length, 1, 'событие переоткрытия предка');
  assert.equal(JSON.parse(reopenEv[0].params[1]).reason, 'gi_resync_reopen_parent');
});

test('retryGiBlockedForResync: нет GI-блоков → ничего не делает, предков не трогает', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks t[\s\S]*?SET status = 'COMMIT'/, reply: { rowCount: 0, rows: [] } },
  ]);
  const res = await retryGiBlockedForResync(c);
  assert.deepEqual(res, { retried: 0, reopened: 0 });
  // Переоткрытие предков НЕ запускается, если ретраить нечего (ранний выход).
  assert.equal(c.calls.some((q) => /UPDATE tasks p[\s\S]*?SET status = 'WAITING_FOR_CHILDREN'/.test(q.sql)), false);
});

test('retryGiBlockedForResync: ретрай без подходящих предков (reopened=0)', async () => {
  const c = fakeClient([
    { re: /UPDATE tasks t[\s\S]*?SET status = 'COMMIT'/, reply: {
      rowCount: 1, rows: [{ id: 'gi1', current_role_id: 'rGI', reason: 'autodeploy_failed' }] } },
    { re: /UPDATE tasks p[\s\S]*?SET status = 'WAITING_FOR_CHILDREN'/, reply: { rowCount: 0, rows: [] } },
  ]);
  const res = await retryGiBlockedForResync(c);
  assert.deepEqual(res, { retried: 1, reopened: 0 });
  // Ретрай-событие есть, событий переоткрытия нет.
  assert.equal(c.calls.filter((q) => /INSERT INTO task_events/.test(q.sql) && /'COMMIT'/.test(q.sql)).length, 1);
  assert.equal(c.calls.filter((q) => /INSERT INTO task_events/.test(q.sql) && /'WAITING_FOR_CHILDREN'/.test(q.sql)).length, 0);
});
