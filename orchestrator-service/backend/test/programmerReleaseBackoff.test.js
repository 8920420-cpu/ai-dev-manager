// PROGRAMMER-RELEASE-BACKOFF-001 — тесты cooldown/backoff на повторный захват одной
// задачи программистом и предохранителя от вечной петли. Мини-клиент pg (как в
// reapOrphanRuns.test.js / restartStuck.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  claimNextClaudeTaskTx,
  escalateProgrammerReleaseLoop,
  parseBackoffScheduleMs,
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

// --- Разбор расписания backoff (чистая функция) ------------------------------

test('parseBackoffScheduleMs: пусто/мусор → дефолт целиком', () => {
  const dflt = [30_000, 120_000, 600_000];
  assert.deepEqual(parseBackoffScheduleMs('', dflt), dflt);
  assert.deepEqual(parseBackoffScheduleMs(null, dflt), dflt);
  assert.deepEqual(parseBackoffScheduleMs('   ', dflt), dflt);
  // Полный мусор без валидных элементов → дефолт.
  assert.deepEqual(parseBackoffScheduleMs('abc,xyz', dflt), dflt);
  // Возвращается КОПИЯ дефолта (не та же ссылка) — мутация результата безопасна.
  assert.notStrictEqual(parseBackoffScheduleMs('', dflt), dflt);
});

test('parseBackoffScheduleMs: CSV длительностей с единицами и голых мс', () => {
  const dflt = [30_000];
  assert.deepEqual(parseBackoffScheduleMs('30s,2m,10m', dflt), [30_000, 120_000, 600_000]);
  assert.deepEqual(parseBackoffScheduleMs('30000,120000,600000', dflt), [30_000, 120_000, 600_000]);
  // Невалидные/непозитивные элементы отбрасываются, валидные остаются.
  assert.deepEqual(parseBackoffScheduleMs('30s, , 0, 2m', dflt), [30_000, 120_000]);
});

// --- Cooldown в захвате программиста -----------------------------------------

// В окне cooldown задача НЕ возвращается claim'ом (picked → 0 строк): программист
// свободен разбирать другие сервисы, а не молотит зациклившуюся задачу.
test('claimNextClaudeTaskTx: cooldown-предикат в CTE picked, задача в cooldown не выдаётся', async () => {
  const c = fakeClient([
    // Задача в окне cooldown → выборка пуста.
    { re: /WITH picked AS/, reply: { rowCount: 0, rows: [] } },
  ]);

  const res = await claimNextClaudeTaskTx(c);
  assert.equal(res.task, null, 'задача в cooldown не выдаётся');

  const picked = c.calls.find((q) => /WITH picked AS/.test(q.sql));
  assert.ok(picked, 'запрос захвата (picked) вызван');

  // Cooldown-предикат: считаем неуспешные PROGRAMMER-прогоны (FAILED/TIMEOUT) ПОСЛЕ
  // последнего SUCCESS и держим задачу до истечения backoff(N).
  assert.ok(/NOT EXISTS \(\s*SELECT 1 FROM \(/.test(picked.sql), 'cooldown как NOT EXISTS-подзапрос');
  assert.ok(/FROM agent_runs ar/.test(picked.sql), 'источник провалов — agent_runs');
  assert.ok(/ar\.status IN \('FAILED','TIMEOUT'\)/.test(picked.sql), 'считаются FAILED и TIMEOUT');
  assert.ok(/ok\.status = 'SUCCESS'/.test(picked.sql), 'окно счёта отсекается по последнему SUCCESS (сброс N)');
  assert.ok(/array_length\(\$1::int\[\], 1\)/.test(picked.sql), 'индекс расписания ограничен его длиной (потолок)');
  assert.ok(/interval '1 millisecond'/.test(picked.sql), 'backoff применяется как интервал в мс');
  assert.ok(/now\(\) < cd\.last_fail/.test(picked.sql), 'сравнение по времени БД (now vs last_fail + backoff)');

  // Существующие механизмы НЕ сломаны: приоритетная очередь и worktree-сериализация.
  assert.ok(/ORDER BY t\.priority ASC, t\.created_at ASC/.test(picked.sql), 'приоритетная очередь: priority ASC (меньше = важнее), FIFO по created_at');
  assert.ok(/t2\.assigned_agent_id IS NOT NULL/.test(picked.sql), 'worktree-per-service предикат сохранён');
  assert.ok(/FOR UPDATE OF t SKIP LOCKED/.test(picked.sql), 'FOR UPDATE SKIP LOCKED сохранён');

  // Расписание backoff передано параметром (массив положительных целых мс).
  const schedule = picked.params[0];
  assert.ok(Array.isArray(schedule) && schedule.length >= 1, 'расписание backoff передано массивом');
  assert.ok(schedule.every((n) => Number.isInteger(n) && n > 0), 'все шаги backoff — положительные целые мс');

  // Транзакция зафиксирована, отката не было.
  assert.ok(c.calls.some((q) => /^COMMIT$/.test(q.sql)), 'транзакция зафиксирована');
  assert.ok(!c.calls.some((q) => /^ROLLBACK$/.test(q.sql)), 'отката нет на пустой выборке');
});

// --- Предохранитель: K подряд провалов → BLOCKED (programmer_release_loop) -----

const ESCALATE_RE = /WITH loop_tasks AS/;

test('escalateProgrammerReleaseLoop: K подряд провалов уводят CODING-задачу в BLOCKED', async () => {
  // Одна задача перешагнула порог K → БД вернула 1 обновлённую строку.
  const c = fakeClient([{ re: ESCALATE_RE, reply: { rowCount: 1, rows: [] } }]);

  const moved = await escalateProgrammerReleaseLoop(c, 5);
  assert.equal(moved, 1, 'одна зациклившаяся задача выведена из CODING');

  const main = c.calls.find((q) => ESCALATE_RE.test(q.sql));
  assert.ok(main, 'основной запрос свипера вызван');

  // Цель — только CODING-задача под PROGRAMMER, не в работе.
  assert.ok(/t\.status = 'CODING'/.test(main.sql), 'берутся только CODING-задачи');
  assert.ok(/r\.code = 'PROGRAMMER'/.test(main.sql), 'только под ролью PROGRAMMER');
  assert.ok(/t\.assigned_agent_id IS NULL/.test(main.sql), 'только не назначенные (не в работе)');

  // Счёт N: FAILED/TIMEOUT после последнего SUCCESS; порог K — параметром.
  assert.ok(/ar\.status IN \('FAILED','TIMEOUT'\)/.test(main.sql), 'считаются FAILED и TIMEOUT');
  assert.ok(/ok\.status = 'SUCCESS'/.test(main.sql), 'окно счёта отсекается по последнему SUCCESS');
  assert.ok(/cd\.n_fail >= \$1/.test(main.sql), 'порог K сравнивается параметром');
  assert.equal(main.params[0], 5, 'порог K передан параметром');

  // Переход и диагностируемое событие.
  assert.ok(/SET status = 'BLOCKED'/.test(main.sql), 'задача переводится в BLOCKED');
  assert.ok(/'reason', 'programmer_release_loop'/.test(main.sql), "событие reason=programmer_release_loop");
  assert.ok(/'failedRuns', b\.n_fail/.test(main.sql), 'в событии число подряд идущих провалов');
});

test('escalateProgrammerReleaseLoop: нет задач за порогом → 0 (петли нет — ничего не трогаем)', async () => {
  const c = fakeClient([{ re: ESCALATE_RE, reply: { rowCount: 0, rows: [] } }]);
  const moved = await escalateProgrammerReleaseLoop(c, 5);
  assert.equal(moved, 0);
});

test('escalateProgrammerReleaseLoop: некорректный порог нормализуется к минимуму 1', async () => {
  const c = fakeClient([{ re: ESCALATE_RE, reply: { rowCount: 0, rows: [] } }]);
  await escalateProgrammerReleaseLoop(c, 0);
  const main = c.calls.find((q) => ESCALATE_RE.test(q.sql));
  assert.equal(main.params[0], 1, 'порог 0 → минимум 1 (свипер не вырождается)');
});

test('escalateProgrammerReleaseLoop: порог по умолчанию — положительное целое (env PROGRAMMER_RELEASE_LOOP_MAX)', async () => {
  const c = fakeClient([{ re: ESCALATE_RE, reply: { rowCount: 0, rows: [] } }]);
  await escalateProgrammerReleaseLoop(c);
  const main = c.calls.find((q) => ESCALATE_RE.test(q.sql));
  assert.ok(Number.isInteger(main.params[0]) && main.params[0] >= 1, 'дефолтный K — положительное целое');
});
