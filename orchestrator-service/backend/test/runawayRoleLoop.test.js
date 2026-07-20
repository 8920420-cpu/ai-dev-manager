// TASK-RUN-LOOP-CAP-001 — тесты общего предохранителя от бесконечных перезапусков
// этапа: K подряд CANCELLED/TIMEOUT-прогонов ЛЮБОЙ роли → BLOCKED с причиной в
// карточке (auto_run_limit) и событии; дальше пуск руками (move на этап).
// Мини-клиент pg отвечает по первому подходящему regex-правилу (как в других тестах db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { escalateRunawayRoleLoops } from '../src/db.js';

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

test('escalateRunawayRoleLoops: K подряд CANCELLED/TIMEOUT любой роли → BLOCKED с пометкой', async () => {
  const c = fakeClient([
    { re: /WITH loop_tasks AS/, reply: { rowCount: 1, rows: [{ id: 'task1' }] } },
  ]);

  const n = await escalateRunawayRoleLoops(c);
  assert.equal(n, 1, 'одна задача остановлена');

  const main = c.calls.find((q) => /WITH loop_tasks AS/.test(q.sql));
  assert.ok(main, 'основной запрос выполнен');
  // Роль НЕ зашита — предохранитель общий (в отличие от ARCHITECT-BUDGET-LOOP-001).
  assert.equal(/r\.code = '/.test(main.sql), false, 'без фильтра по коду роли');
  // Уже остановленные и ждущие задачи не трогаем; занятые агентом — тоже.
  // NEEDS_INPUT исключён: задача стоит на вопросе к человеку, её прогоны не идут,
  // и записывать ей исчерпание бюджета (BLOCKED) не за что.
  assert.match(main.sql, /NOT IN \('DONE','CANCELLED','FAILED','BLOCKED','WAITING_FOR_CHILDREN','NEEDS_INPUT'\)/);
  assert.match(main.sql, /t\.assigned_agent_id IS NULL/);
  // Считаем только оборванные без вердикта прогоны ПОСЛЕ последнего SUCCESS роли.
  assert.match(main.sql, /ar\.status IN \('CANCELLED','TIMEOUT'\)/);
  assert.match(main.sql, /ok\.status = 'SUCCESS'/);
  assert.match(main.sql, /cd\.n_cancel >= \$1/);
  // Ручное перемещение (runbook: «переместите задачу на этап») выдаёт этапу свежий
  // бюджет: окно счёта — после последнего SUCCESS роли ИЛИ manual-move (что позже).
  // Инцидент 09.07: задача, возвращённая руками после починки причины, мгновенно
  // блокировалась повторно тем же счётчиком, ни разу не запустив этап.
  assert.match(main.sql, /GREATEST\(/);
  assert.match(main.sql, /mv\.payload_json->>'via' = 'manual-move'/);
  assert.equal(main.params[0], 5, 'дефолтный порог = 5 (узкие жнецы срабатывают раньше)');
  // Пометка — в карточке задачи (auto_run_limit) и в событии.
  assert.match(main.sql, /auto_run_limit/);
  assert.match(main.sql, /COALESCE\(t\.data_card, '\{\}'::jsonb\)/);
  assert.match(main.sql, /SET status = 'BLOCKED'/);
  assert.match(main.sql, /'TASK_BLOCKED'/);
  assert.match(main.sql, /'run_budget_exhausted'/);
  // Текст причины подсказывает действие: разобраться и запустить вручную.
  assert.match(main.params[1], /перезапускалась по кругу/i);
  assert.match(main.params[1], /запустите вручную/i);
});

test('escalateRunawayRoleLoops: порог настраивается и нормализуется в >= 1', async () => {
  const c = fakeClient([
    { re: /WITH loop_tasks AS/, reply: { rowCount: 0, rows: [] } },
  ]);
  await escalateRunawayRoleLoops(c, 7);
  assert.equal(c.calls[0].params[0], 7, 'порог берётся из аргумента');

  await escalateRunawayRoleLoops(c, 0);
  assert.equal(c.calls[1].params[0], 1, 'порог не опускается ниже 1');
});
