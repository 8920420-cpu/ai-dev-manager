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

// PROGRAMMER-UNIFY-001 (фикс 10-минутного среза): рантайм-жнец сравнивает возраст
// прогона программиста с бОльшим таймаутом (CLAUDE_ASSIGN_TIMEOUT_MS), а не с общим
// ROLE_TIMEOUT_MS — иначе живая 20-минутная сессия кодинга гасится на 10-й минуте.
test('reap (runtime): у PROGRAMMER свой (больший) таймаут через CASE по роли', async () => {
  __resetClockGuard();
  const c = fakeClient([
    { re: /EXTRACT\(EPOCH/, reply: { rows: [{ ms: 1_000_000 }], rowCount: 1 } },
    { re: REAP_RE, reply: { rowCount: 0, rows: [] } },
  ]);

  await reapOrphanRunningRuns(c, { ageCheck: true });

  const main = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(main, 'основной запрос вызван');
  // Роль прогона доступна предикату (LEFT JOIN roles) и ветвит таймаут CASE'ом.
  assert.ok(/LEFT JOIN roles r ON r\.id = ar\.role_id/.test(main.sql), 'роль прогона приджойнена');
  assert.ok(/CASE WHEN COALESCE\(r\.code, ''\) = 'PROGRAMMER'/.test(main.sql), 'CASE по роли PROGRAMMER');
  // Переданы ОБА таймаута: общий и программистский, программистский не меньше.
  assert.equal(typeof main.params[2], 'number', 'общий таймаут передан числом');
  assert.equal(typeof main.params[3], 'number', 'таймаут программиста передан числом');
  assert.ok(main.params[3] >= main.params[2], 'таймаут программиста не меньше общего');
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

// HOST-ORPHAN-TIMEOUT-001: убитый посреди прогона host-runner (PIPELINE_SERVICE во
// время docker compose build, GIT_INTEGRATOR во время коммита) не зовёт
// release-host-task → прогон висит RUNNING. Рантайм-жнец возвращает его в пул, но
// сравнивает возраст с ОТДЕЛЬНЫМ бОльшим таймаутом host-ролей (иначе живой прогон
// срежется посреди сборки), и пишет диагностируемое событие host_orphan_timeout.
test('reap (runtime): host-роли реапятся по своему бОльшему таймауту через CASE по кодам ролей', async () => {
  __resetClockGuard();
  const c = fakeClient([
    { re: /EXTRACT\(EPOCH/, reply: { rows: [{ ms: 1_000_000 }], rowCount: 1 } },
    { re: REAP_RE, reply: { rowCount: 1, rows: [] } },
  ]);

  await reapOrphanRunningRuns(c, { ageCheck: true });
  const main = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(main, 'основной запрос вызван');

  // Возраст host-роли ветвится через ANY(...::text[]) по кодам host-ролей.
  assert.ok(/= ANY\(\$6::text\[\]\)/.test(main.sql), 'host-ветка возраста через ANY по кодам ролей');
  // Программистская ветка сохранена (не сломали PROGRAMMER-UNIFY-001).
  assert.ok(/CASE[\s\S]*WHEN COALESCE\(r\.code, ''\) = 'PROGRAMMER'/.test(main.sql), 'ветка PROGRAMMER сохранена');

  // Переданы коды host-ролей и отдельный host-таймаут.
  const hostCodes = main.params[5];
  assert.ok(Array.isArray(hostCodes), 'коды host-ролей переданы массивом');
  assert.ok(hostCodes.includes('PIPELINE_SERVICE'), 'PIPELINE_SERVICE в кодах host-ролей');
  assert.ok(hostCodes.includes('GIT_INTEGRATOR'), 'GIT_INTEGRATOR в кодах host-ролей');

  const roleTimeout = main.params[2];
  const hostTimeout = main.params[4];
  assert.equal(typeof hostTimeout, 'number', 'host-таймаут передан числом');
  assert.ok(hostTimeout > roleTimeout, 'host-таймаут БОЛЬШЕ общего (живой docker-прогон не срезается посреди build)');

  // Живой прогон в пределах host-таймаута не трогается, зависший — возвращается:
  // возраст сравнивается именно с host-таймаутом, а он с запасом над сборкой.
  const alive = roleTimeout + 60_000;   // старше общего, но host-прогон ещё живой
  const hung = hostTimeout + 60_000;    // перешагнул host-таймаут → орфан
  assert.ok(alive < hostTimeout, 'прогон возрастом чуть больше общего таймаута ещё в пределах host-таймаута → не реапится');
  assert.ok(hung > hostTimeout, 'прогон старше host-таймаута → реапится');

  // Возврат в пул: freed CTE снимает assigned_agent_id.
  assert.ok(/freed AS \([\s\S]*assigned_agent_id = NULL/.test(main.sql), 'freed CTE освобождает слот (возврат в пул)');

  // Диагностируемое событие для host-роли: кто (roleCode), почему, сколько висела (hungMs).
  assert.ok(/'reason', 'host_orphan_timeout'/.test(main.sql), "событие reason=host_orphan_timeout");
  assert.ok(/'hungMs', s\.hung_ms/.test(main.sql), 'в событии длительность зависания hungMs');
  assert.ok(/'roleCode', s\.role_code/.test(main.sql), 'в событии код роли roleCode');
  // stale CTE экспонирует роль и длительность для события.
  assert.ok(/r\.code AS role_code/.test(main.sql), 'stale CTE отдаёт код роли');
  assert.ok(/AS hung_ms/.test(main.sql), 'stale CTE считает длительность зависания');
});

// На стартовом reconcile (ageCheck=false) гасим ВСЕ RUNNING безусловно; причина —
// «рестарт», а не «зависание по таймауту», поэтому host-ветки события НЕТ.
test('reap (startup): host-ветки события host_orphan_timeout нет', async () => {
  __resetClockGuard();
  const c = fakeClient([{ re: REAP_RE, reply: { rowCount: 2, rows: [] } }]);
  await reapOrphanRunningRuns(c);
  const main = c.calls.find((q) => REAP_RE.test(q.sql));
  assert.ok(main, 'основной запрос вызван');
  assert.ok(!/host_orphan_timeout/.test(main.sql), 'на старте host-ветки события нет (общая причина рестарта)');
  assert.equal(main.params.length, 2, 'на старте таймаут-параметры не передаются');
});
