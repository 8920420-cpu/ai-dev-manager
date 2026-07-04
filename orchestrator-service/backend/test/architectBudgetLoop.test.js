// ARCHITECT-BUDGET-LOOP-001 — тесты диагностики мега-эпика, который Архитектор не
// успевает продумать за один прогон: после K подряд CANCELLED/TIMEOUT-прогонов
// задача уходит в BLOCKED С ВНЯТНОЙ ПРИЧИНОЙ (в карточке и событии), а не молча.
// Мини-клиент pg отвечает по первому подходящему regex-правилу (как в других тестах db).
import test from 'node:test';
import assert from 'node:assert/strict';
import { escalateArchitectBudgetLoop } from '../src/db.js';

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

test('escalateArchitectBudgetLoop: K подряд CANCELLED/TIMEOUT → BLOCKED с причиной', async () => {
  const c = fakeClient([
    { re: /WITH loop_tasks AS/, reply: { rowCount: 1, rows: [{ id: 'epic1' }] } },
  ]);

  const n = await escalateArchitectBudgetLoop(c);
  assert.equal(n, 1, 'одна задача уведена в BLOCKED');

  const main = c.calls.find((q) => /WITH loop_tasks AS/.test(q.sql));
  assert.ok(main, 'основной запрос выполнен');
  // Целимся строго в Архитектора в ARCHITECTURE, не занятого агентом.
  assert.match(main.sql, /t\.status = 'ARCHITECTURE'/);
  assert.match(main.sql, /r\.code = 'ARCHITECT'/);
  assert.match(main.sql, /t\.assigned_agent_id IS NULL/);
  // Считаем только отменённые/просроченные прогоны ПОСЛЕ последнего SUCCESS.
  assert.match(main.sql, /ar\.status IN \('CANCELLED','TIMEOUT'\)/);
  assert.match(main.sql, /ok\.status = 'SUCCESS'/);
  // Порог — из параметра (дефолт 3).
  assert.match(main.sql, /cd\.n_cancel >= \$1/);
  assert.equal(main.params[0], 3, 'дефолтный порог = 3 (три CANCELLED подряд)');
  // Причина кладётся В КАРТОЧКУ задачи (architect_budget_block) и В СОБЫТИЕ.
  assert.match(main.sql, /architect_budget_block/);
  assert.match(main.sql, /SET status = 'BLOCKED'/);
  assert.match(main.sql, /'TASK_BLOCKED'/);
  assert.match(main.sql, /'architect_budget_exhausted'/);
  // Текст причины — человекочитаемый и подсказывает действие.
  assert.match(main.params[1], /слишком крупная/i);
  assert.match(main.params[1], /разбейте|увеличьте бюджет/i);
});

test('escalateArchitectBudgetLoop: нет застрявших эпиков → 0, порог настраивается', async () => {
  const c = fakeClient([
    { re: /WITH loop_tasks AS/, reply: { rowCount: 0, rows: [] } },
  ]);
  const n = await escalateArchitectBudgetLoop(c, 5);
  assert.equal(n, 0);
  const main = c.calls.find((q) => /WITH loop_tasks AS/.test(q.sql));
  assert.equal(main.params[0], 5, 'порог берётся из аргумента');
});

test('escalateArchitectBudgetLoop: некорректный порог нормализуется в >= 1', async () => {
  const c = fakeClient([
    { re: /WITH loop_tasks AS/, reply: { rowCount: 0, rows: [] } },
  ]);
  await escalateArchitectBudgetLoop(c, 0);
  const main = c.calls.find((q) => /WITH loop_tasks AS/.test(q.sql));
  assert.equal(main.params[0], 1, 'порог не опускается ниже 1');
});
