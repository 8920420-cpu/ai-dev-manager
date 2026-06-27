// TASK-RESTART-001 — тесты массового перезапуска зависших задач.
// Мини-клиент pg (как в taskMutations.test.js): отвечает по первому regex-правилу.
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

test('restartStuck: зависшие задачи проекта → RESTART под Приёмщиком, событие manual-restart', async () => {
  const c = fakeClient([
    // computeEntry → entryRole: Приёмщик задач существует.
    { re: /SELECT id FROM roles WHERE code = 'TASK_INTAKE_OFFICER'/, reply: { rowCount: 1, rows: [{ id: 'rIntake' }] } },
    // У проекта нет графа этапов → entryStageKey = null (позиционный маршрут).
    { re: /FROM project_stage_edges WHERE project_id/, reply: { rowCount: 0, rows: [] } },
    // Список проектов с зависшими задачами.
    { re: /SELECT DISTINCT project_id FROM tasks/, reply: { rowCount: 1, rows: [{ project_id: 'p1' }] } },
    // Основной запрос перезапуска: 2 задачи переведены в RESTART.
    { re: /WITH targets AS/, reply: { rowCount: 2, rows: [{ task_id: 't1' }, { task_id: 't2' }] } },
  ]);

  const res = await restartStuckTasksTx(c);
  assert.equal(res.restarted, 2);

  const main = c.calls.find((q) => /WITH targets AS/.test(q.sql));
  assert.ok(main, 'основной запрос перезапуска вызван');
  assert.equal(main.params[0], 'p1', 'проект');
  assert.equal(main.params[1], 'rIntake', 'роль входа = Приёмщик задач');
  assert.equal(main.params[2], null, 'без графа — current_stage_key NULL');
  assert.ok(/status = 'RESTART'/.test(main.sql), 'статус переводится в RESTART');
  assert.ok(/assigned_agent_id IS NULL/.test(main.sql), 'берутся только задачи «не в работе»');
  assert.ok(
    /NOT IN \('DONE','CANCELLED','FAILED','WAITING_FOR_CHILDREN','RESTART'\)/.test(main.sql),
    'исключены терминальные/ожидающие/уже перезапущенные',
  );
  assert.ok(/manual-restart/.test(main.sql), 'событие помечено source=manual-restart');

  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)), 'транзакция зафиксирована');
});

test('restartStuck: зависших задач нет → restarted = 0, проектов не обходим', async () => {
  const c = fakeClient([
    { re: /SELECT DISTINCT project_id FROM tasks/, reply: { rowCount: 0, rows: [] } },
  ]);
  const res = await restartStuckTasksTx(c);
  assert.equal(res.restarted, 0);
  assert.equal(c.calls.some((q) => /WITH targets AS/.test(q.sql)), false, 'основной запрос не вызывался');
  assert.ok(c.calls.some((q) => /COMMIT/.test(q.sql)));
});

test('restartStuck: нет роли Приёмщика в проекте → проект пропущен', async () => {
  const c = fakeClient([
    { re: /SELECT id FROM roles WHERE code = 'TASK_INTAKE_OFFICER'/, reply: { rowCount: 0, rows: [] } },
    { re: /FROM global_stages gs/, reply: { rowCount: 0, rows: [] } },
    { re: /SELECT id FROM roles WHERE code = \$1/, reply: { rowCount: 0, rows: [] } },
    { re: /SELECT DISTINCT project_id FROM tasks/, reply: { rowCount: 1, rows: [{ project_id: 'p1' }] } },
  ]);
  const res = await restartStuckTasksTx(c);
  assert.equal(res.restarted, 0);
  assert.equal(c.calls.some((q) => /WITH targets AS/.test(q.sql)), false, 'без роли входа задачи не трогаем');
});
