// RUNNER-RUNTIME-REAP-001 — тесты сброса осиротевших RUNNING-прогонов.
// Мини-клиент pg (как в restartStuck.test.js): отвечает по первому regex-правилу.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reapOrphanRunningRuns } from '../src/db.js';
import { __resetClockGuard } from '../src/clockGuard.js';

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

// Главный запрос reap'а — единственный с CTE freed AS (UPDATE tasks ... assigned_agent_id = NULL).
const REAP_RE = /WITH stale AS[\s\S]*freed AS/;

test('reap (startup, ageCheck=false): гасит ВСЕ RUNNING безусловно, без проверки возраста и без clockGuard', async () => {
  __resetClockGuard();
  const c = fakeClient([{ re: REAP_RE, reply: { rowCount: 2, rows: [] } }]);

  const freed = await reapOrphanRunningRuns(c);
  assert.equal(freed, 2);

  const main = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(main, 'основной запрос вызван');
  // Без проверки возраста: нет предиката по started_at.
  assert.ok(!/started_at < now\(\)/.test(main.sql), 'на старте возраст не проверяется');
  // reason/errText переданы параметрами для стартового сценария.
  assert.equal(main.params[1], 'orchestrator_restart_reconcile', 'reason = restart_reconcile');
  assert.ok(/restarted/.test(main.params[0]), 'errText про рестарт');
  // clockGuard на старте не зовётся (нет SELECT EXTRACT EPOCH).
  assert.ok(!c.calls.some((q) => /EXTRACT\(EPOCH/.test(q.sql)), 'clockGuard на старте не дёргается');
});

test('reap (runtime, ageCheck=true): гасит только RUNNING старше таймаута, c clockGuard и параметром таймаута', async () => {
  __resetClockGuard();
  const c = fakeClient([
    // clockGuard читает время БД — отдаём конечное значение, чтобы он заякорился.
    { re: /EXTRACT\(EPOCH/, reply: { rows: [{ ms: 1_000_000 }], rowCount: 1 } },
    { re: REAP_RE, reply: { rowCount: 1, rows: [] } },
  ]);

  const freed = await reapOrphanRunningRuns(c, { ageCheck: true });
  assert.equal(freed, 1);

  // clockGuard вызван до сравнения возраста.
  assert.ok(c.calls.some((q) => /EXTRACT\(EPOCH/.test(q.sql)), 'clockGuard вызван в рантайме');

  const main = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(main, 'основной запрос вызван');
  // Проверка возраста по таймауту присутствует.
  assert.ok(/started_at < now\(\)/.test(main.sql), 'в рантайме проверяется возраст started_at');
  assert.ok(/interval '1 millisecond'/.test(main.sql), 'возраст в миллисекундах');
  // reason/errText — рантаймовые, плюс таймаут передан третьим параметром.
  assert.equal(main.params[1], 'orphan_run_timeout', 'reason = orphan_run_timeout');
  assert.ok(/timeout/.test(main.params[0]), 'errText про таймаут');
  assert.equal(typeof main.params[2], 'number', 'таймаут передан числом');
  assert.ok(main.params[2] > 0, 'таймаут положительный');
});

test('reap: нет осиротевших прогонов → freed = 0', async () => {
  __resetClockGuard();
  const c = fakeClient([
    { re: /EXTRACT\(EPOCH/, reply: { rows: [{ ms: 1_000_000 }], rowCount: 1 } },
    { re: REAP_RE, reply: { rowCount: 0, rows: [] } },
  ]);
  const freed = await reapOrphanRunningRuns(c, { ageCheck: true });
  assert.equal(freed, 0);
});
