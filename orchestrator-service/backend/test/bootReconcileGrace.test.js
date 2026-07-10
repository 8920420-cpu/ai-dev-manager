// BOOT-RECONCILE-GRACE-001 — щадящий boot-reconcile: рестарт оркестратора посреди
// живого прогона НЕ гасит его в TIMEOUT, если он моложе штатного таймаута роли.
// Деплой-стадия pipeline сама пересоздаёт контейнер оркестратора, а host-runner'ы и
// Claude-агенты переживают рестарт и досдают результат — прежняя безусловная зачистка
// убивала чужие живые прогоны. Проверяем ядро reconcileOnStartupTx на fake-клиенте.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileOnStartupTx } from '../src/db.js';
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

const REAP_RE = /WITH stale AS[\s\S]*freed AS/;                 // реап осиротевших RUNNING
const RELEASE_RE = /te\.event_type = 'AGENT_ASSIGNED'/;         // release Programmer-назначений

function bootRules() {
  return [
    { re: /EXTRACT\(EPOCH/, reply: { rows: [{ ms: 1_000_000 }], rowCount: 1 } },
    { re: REAP_RE, reply: { rowCount: 1, rows: [] } },
    { re: RELEASE_RE, reply: { rowCount: 2, rows: [{ task_id: 't1' }, { task_id: 't2' }] } },
  ];
}

test('reconcileOnStartupTx: реап только просроченных RUNNING (grace), без безусловной зачистки', async () => {
  __resetClockGuard();
  const c = fakeClient(bootRules());
  await reconcileOnStartupTx(c, { deployRef: 'sha-boot-1' });

  const reap = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(reap, 'реап вызван');
  // Grace: гасим только RUNNING старше штатного таймаута роли (возрастной предикат),
  // молодые прогоны переживают рестарт как «осиротевшие кандидаты».
  assert.ok(/started_at < now\(\)/.test(reap.sql), 'boot-реап проверяет возраст, а не гасит всё безусловно');
  assert.ok(/CASE WHEN COALESCE\(r\.code, ''\) = 'PROGRAMMER'/.test(reap.sql), 'таймаут ветвится по роли (PROGRAMMER/host свои)');
});

test('reconcileOnStartupTx: clockGuard сверяет часы БД до сравнения возраста', async () => {
  __resetClockGuard();
  const c = fakeClient(bootRules());
  await reconcileOnStartupTx(c, { deployRef: 'sha-boot-1' });
  assert.ok(c.calls.some((q) => /EXTRACT\(EPOCH/.test(q.sql)), 'clockGuard вызван (защита от скачка часов БД)');
});

test('reconcileOnStartupTx: событие реапа помечено boot-маркером деплоя (req.3)', async () => {
  __resetClockGuard();
  const c = fakeClient(bootRules());
  await reconcileOnStartupTx(c, { deployRef: 'sha-boot-1' });
  const reap = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(/'bootReconcile', true/.test(reap.sql), 'реап помечен bootReconcile=true');
  assert.ok(/'deployRef', \$\d+::text/.test(reap.sql), 'в событие подставлен деплой-маркер');
  assert.equal(reap.params[reap.params.length - 1], 'sha-boot-1', 'deployRef проброшен параметром');
});

test('reconcileOnStartupTx: Programmer-назначения освобождаются по штатному таймауту, а НЕ немедленно (timeoutMs≠0)', async () => {
  __resetClockGuard();
  const c = fakeClient(bootRules());
  const released = await reconcileOnStartupTx(c, { deployRef: 'sha-boot-1' });

  const rel = c.calls.find((q) => RELEASE_RE.test(q.sql));
  assert.ok(rel, 'release Programmer-назначений вызван');
  // Ключевой фикс: НЕ 0. Иначе timeoutMs=0 освободил бы живую сессию Разработчика,
  // сведя на нет grace-период (её RUNNING-прогон погасился бы в TIMEOUT).
  assert.equal(typeof rel.params[0], 'number', 'таймаут release — число');
  assert.ok(rel.params[0] > 0, 'release с grace-таймаутом (>0), а не немедленный (0)');
  assert.equal(rel.params[1], 'orchestrator_restart_reconcile', 'причина — стартовая реконсиляция');
  // Возврат — число освобождённых Programmer-задач (rowCount release-запроса).
  assert.equal(released, 2);
});

test('reconcileOnStartupTx: реап предшествует release Programmer-назначений', async () => {
  __resetClockGuard();
  const c = fakeClient(bootRules());
  await reconcileOnStartupTx(c, { deployRef: 'sha-boot-1' });
  const reapIdx = c.calls.findIndex((q) => REAP_RE.test(q.sql));
  const relIdx = c.calls.findIndex((q) => RELEASE_RE.test(q.sql));
  assert.ok(reapIdx >= 0 && relIdx > reapIdx, 'сначала реап RUNNING, затем release назначений');
});
