// CLOCK-GUARD-001 — тесты устойчивости таймаутов к скачкам настенных часов.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideClockSkew,
  reconcileClockSkew,
  __resetClockGuard,
  __setBaselineForTest,
} from '../src/clockGuard.js';

// Фейковый клиент: матчит SQL по regex, отдаёт заданные ответы, копит вызовы.
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

const nowRule = (dbMs) => ({ re: /EXTRACT\(EPOCH FROM now\(\)\)/, reply: () => ({ rows: [{ ms: dbMs }] }) });

// --- decideClockSkew (чистая логика) ----------------------------------------

test('decideClockSkew: нет базлайна → anchor', () => {
  const d = decideClockSkew(null, 1000, 1_000_000);
  assert.equal(d.action, 'anchor');
  assert.equal(d.jumpMs, 0);
});

test('decideClockSkew: прямой скачок БД сильно больше реального → compensate', () => {
  const base = { monoMs: 1000, dbMs: 1_000_000 };
  // реально прошло 11 c, БД ушла на 11 c + 2 ч
  const d = decideClockSkew(base, 1000 + 11_000, 1_000_000 + 11_000 + 7_200_000);
  assert.equal(d.action, 'compensate');
  assert.equal(d.jumpMs, 7_200_000);
});

test('decideClockSkew: расхождение в пределах порога → none', () => {
  const base = { monoMs: 1000, dbMs: 1_000_000 };
  const d = decideClockSkew(base, 1000 + 11_000, 1_000_000 + 11_050); // джиттер 50 мс
  assert.equal(d.action, 'none');
});

test('decideClockSkew: обратный скачок БД → reanchor (без сдвига)', () => {
  const base = { monoMs: 1000, dbMs: 1_000_000 };
  const d = decideClockSkew(base, 1000 + 11_000, 1_000_000 + 11_000 - 5_000_000);
  assert.equal(d.action, 'reanchor');
});

// --- reconcileClockSkew (состояние + SQL) -----------------------------------

test('reconcileClockSkew: первый вызов только якорится, без UPDATE', async () => {
  __resetClockGuard();
  const c = fakeClient([nowRule(1_000_000)]);
  const d = await reconcileClockSkew(c, { monoMs: 1000 });
  assert.equal(d.action, 'anchor');
  assert.equal(c.calls.some((q) => /UPDATE/.test(q.sql)), false);
});

test('reconcileClockSkew: прямой скачок → сдвигает agent_runs и task_events', async () => {
  __resetClockGuard();
  __setBaselineForTest({ monoMs: 1000, dbMs: 1_000_000 });
  const c = fakeClient([
    nowRule(1_000_000 + 11_000 + 7_200_000),
    { re: /UPDATE agent_runs/, reply: { rowCount: 3 } },
    { re: /UPDATE task_events/, reply: { rowCount: 1 } },
  ]);
  const d = await reconcileClockSkew(c, { monoMs: 1000 + 11_000 });
  assert.equal(d.action, 'compensate');
  const ar = c.calls.find((q) => /UPDATE agent_runs/.test(q.sql));
  const te = c.calls.find((q) => /UPDATE task_events/.test(q.sql));
  assert.ok(ar, 'сдвинул agent_runs');
  assert.ok(te, 'сдвинул task_events');
  assert.equal(ar.params[0], '7200000', 'сдвиг = величине скачка в мс');
  assert.equal(te.params[0], '7200000');
});

test('reconcileClockSkew: нормальный ход времени → none, без UPDATE', async () => {
  __resetClockGuard();
  __setBaselineForTest({ monoMs: 1000, dbMs: 1_000_000 });
  const c = fakeClient([nowRule(1_000_000 + 11_050)]);
  const d = await reconcileClockSkew(c, { monoMs: 1000 + 11_000 });
  assert.equal(d.action, 'none');
  assert.equal(c.calls.some((q) => /UPDATE/.test(q.sql)), false);
});

test('reconcileClockSkew: дебаунс — повторный вызов в окне MIN_INTERVAL не лезет в БД', async () => {
  __resetClockGuard();
  __setBaselineForTest({ monoMs: 1000, dbMs: 1_000_000 });
  const c = fakeClient([nowRule(1_000_000)]);
  const d = await reconcileClockSkew(c, { monoMs: 1000 + 5_000 }); // < 10 c
  assert.equal(d.action, 'debounced');
  assert.equal(c.calls.length, 0, 'ни одного запроса к БД');
});
