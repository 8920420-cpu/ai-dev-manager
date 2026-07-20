// TASK-RESTART-001 — тесты массового перезапуска зависших задач.
// RESTART-IN-PLACE: задачи перезапускаются на текущем этапе, без переноса на
// Приёмщика. Мини-клиент pg отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { restartStuckTasksTx } from '../src/db.js';

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

test('restartStuck: зависшие задачи перезапускаются НА ТЕКУЩЕМ этапе (без переноса на Приёмщика)', async () => {
  const c = fakeClient([
    { re: /WITH targets AS/, reply: { rowCount: 2, rows: [{ task_id: 't1' }, { task_id: 't2' }] } },
  ]);

  const res = await restartStuckTasksTx(c);
  assert.equal(res.restarted, 2);

  const main = c.calls.find((q) => /WITH targets AS/.test(q.sql));
  assert.ok(main, 'основной запрос перезапуска вызван');
  // Ключевое: роль/стадию/статус НЕ трогаем — задача остаётся на своём этапе.
  assert.ok(!/SET status = 'RESTART'/.test(main.sql), 'статус НЕ переводится в RESTART');
  assert.ok(!/current_role_id =/.test(main.sql), 'роль НЕ меняется (нет переброса на Приёмщика)');
  assert.ok(!/current_stage_key =/.test(main.sql), 'стадия НЕ меняется');
  assert.ok(/restart_in_place/.test(main.sql), 'событие помечено reason=restart_in_place');
  assert.ok(/'source', 'manual-restart'/.test(main.sql), 'source=manual-restart');
  assert.ok(/assigned_agent_id IS NULL/.test(main.sql), 'берутся только задачи «не в работе»');
  assert.ok(
    /NOT IN \('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','NEEDS_INPUT'\)/.test(main.sql),
    'исключены терминальные/ожидающие (в т.ч. ждущие ответа человека: массовый '
      + 'перезапуск не должен затирать заданный агентом вопрос)',
  );
  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)), 'транзакция зафиксирована');
});

test('restartStuck: зависших задач нет → restarted = 0', async () => {
  const c = fakeClient([
    { re: /WITH targets AS/, reply: { rowCount: 0, rows: [] } },
  ]);
  const res = await restartStuckTasksTx(c);
  assert.equal(res.restarted, 0);
  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)));
});
