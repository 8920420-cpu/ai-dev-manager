// DB-FINALIZE-RETRY-001 — устойчивость финализации прогона роли к транзиентным
// обрывам соединения с БД. Проверяем чистые части механизма (ретрай пост-LLM записи
// на свежем соединении + идемпотентный гейт по статусу agent_run) без реальной сети,
// по образцу мини-клиента pg из codexReasoning.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __finalizeRetryInternals } from '../src/db.js';

const { FINALIZE_RETRY_BACKOFF_MS, isRunAlreadyFinalized, finalizeWithConnRetry } = __finalizeRetryInternals;

// Транзиентный обрыв соединения (isDbConnectionError → true): текст «Connection
// terminated» либо SQLSTATE класса 08/57P01 (см. bootClaimGuard.isDbConnectionError).
function connError(msg = 'Connection terminated unexpectedly') {
  return new Error(msg);
}
// Бизнес-ошибка запроса (не обрыв) — ретраить нельзя.
function businessError() {
  const e = new Error('duplicate key value violates unique constraint');
  e.code = '23505';
  return e;
}

// --- isRunAlreadyFinalized ---------------------------------------------------

test('isRunAlreadyFinalized: RUNNING → false (финализируем)', async () => {
  const c = { async query() { return { rowCount: 1, rows: [{ status: 'RUNNING' }] }; } };
  assert.equal(await isRunAlreadyFinalized(c, 'run1'), false);
});

test('isRunAlreadyFinalized: не RUNNING (SUCCESS/FAILED) → true (уже финализирован)', async () => {
  const success = { async query() { return { rowCount: 1, rows: [{ status: 'SUCCESS' }] }; } };
  const failed = { async query() { return { rowCount: 1, rows: [{ status: 'FAILED' }] }; } };
  assert.equal(await isRunAlreadyFinalized(success, 'run1'), true);
  assert.equal(await isRunAlreadyFinalized(failed, 'run1'), true);
});

test('isRunAlreadyFinalized: нет строки прогона или пустой id → false (не мешаем прежнему поведению)', async () => {
  const none = { async query() { return { rowCount: 0, rows: [] }; } };
  assert.equal(await isRunAlreadyFinalized(none, 'run1'), false);
  let called = false;
  const spy = { async query() { called = true; return { rowCount: 0, rows: [] }; } };
  assert.equal(await isRunAlreadyFinalized(spy, null), false);
  assert.equal(called, false, 'при пустом agentRunId запрос не делаем');
});

// --- finalizeWithConnRetry: ретрай ТОЛЬКО транзиентного обрыва ----------------

test('finalizeWithConnRetry: успех с первой попытки — свежее соединение не открываем', async () => {
  let withFreshCalls = 0;
  const res = await finalizeWithConnRetry(
    async (client) => ({ client, ok: true }),
    'claim-conn',
    null,
    { withFresh: (fn) => { withFreshCalls += 1; return fn('fresh'); }, sleep: async () => {} },
  );
  assert.equal(res.ok, true);
  assert.equal(res.client, 'claim-conn', 'финализация прошла на claim-соединении');
  assert.equal(withFreshCalls, 0, 'ретрая не было');
});

test('finalizeWithConnRetry: одиночный обрыв на claim-соединении → повтор на свежем, результат не потерян', async () => {
  let attempts = 0;
  const clientsSeen = [];
  const res = await finalizeWithConnRetry(
    async (client) => {
      attempts += 1;
      clientsSeen.push(client);
      if (attempts === 1) throw connError(); // обрыв во время финализации на claim-conn
      return { client, ok: true };
    },
    'claim-conn',
    null,
    { withFresh: (fn) => fn('fresh-conn'), sleep: async () => {}, backoff: [100, 200, 400] },
  );
  assert.equal(res.ok, true, 'результат прогона записан, а не потерян');
  assert.equal(res.client, 'fresh-conn', 'повтор выполнен на СВЕЖЕМ соединении');
  assert.equal(attempts, 2);
  assert.deepEqual(clientsSeen, ['claim-conn', 'fresh-conn']);
});

test('finalizeWithConnRetry: небизнес-ошибка (не обрыв) пробрасывается сразу, без ретрая', async () => {
  let attempts = 0;
  await assert.rejects(
    () => finalizeWithConnRetry(
      async () => { attempts += 1; throw businessError(); },
      'claim-conn',
      null,
      { withFresh: (fn) => fn('fresh'), sleep: async () => {} },
    ),
    /unique constraint/,
  );
  assert.equal(attempts, 1, 'бизнес-ошибку не ретраим');
});

test('finalizeWithConnRetry: обрыв на всех попытках → ошибка всплывает (не глушится); backoff 100/200/400', async () => {
  let attempts = 0;
  const sleeps = [];
  await assert.rejects(
    () => finalizeWithConnRetry(
      async () => { attempts += 1; throw connError(); },
      'claim-conn',
      null,
      { withFresh: (fn) => fn('fresh'), sleep: async (ms) => { sleeps.push(ms); }, backoff: [100, 200, 400] },
    ),
    /Connection terminated/,
  );
  assert.equal(attempts, 4, '1 попытка на claim + 3 повтора на свежем соединении');
  assert.deepEqual(sleeps, [100, 200, 400], 'экспоненциальная задержка перед каждым повтором');
});

test('finalizeWithConnRetry: некуда открыть свежее соединение (нет cfg/withFresh) → прежнее поведение (ошибка сразу)', async () => {
  let attempts = 0;
  await assert.rejects(
    () => finalizeWithConnRetry(
      async () => { attempts += 1; throw connError(); },
      'claim-conn',
      null, // cfg отсутствует
      { sleep: async () => {} }, // и deps.withFresh не передан
    ),
    /Connection terminated/,
  );
  assert.equal(attempts, 1, 'без свежего соединения ретраев нет');
});

test('дефолтный backoff — [100, 200, 400] мс', () => {
  assert.deepEqual(FINALIZE_RETRY_BACKOFF_MS, [100, 200, 400]);
});

// --- Идемпотентность повторной финализации (критерий приёмки) ----------------
// Модель «потерянного ack COMMIT»: первая попытка на claim-соединении ФАКТИЧЕСКИ
// применила запись в БД (agent_run→SUCCESS, событие вставлено), но подтверждение
// COMMIT потерялось из-за обрыва → бросок. Ретрай на свежем соединении обязан
// увидеть прогон уже финализированным и НЕ задваивать события/переход.

function makeFakeDb() {
  return { runStatus: 'RUNNING', events: 0 };
}

// Мини-клиент pg поверх общего состояния db (claim и свежее соединение делят одну
// «БД»). failCommitOnce=true — этот клиент один раз роняет COMMIT после применённых
// изменений (эмуляция потерянного ack при обрыве соединения).
function makeClient(db, { failCommitOnce = false } = {}) {
  let commitFailed = false;
  return {
    async query(sql) {
      if (/^\s*BEGIN/.test(sql) || /^\s*ROLLBACK/.test(sql)) return { rowCount: 0, rows: [] };
      if (/SELECT status.*FROM agent_runs.*FOR UPDATE/.test(sql)) {
        return { rowCount: 1, rows: [{ status: db.runStatus }] };
      }
      if (/UPDATE agent_runs SET status/.test(sql)) { db.runStatus = 'SUCCESS'; return { rowCount: 1, rows: [] }; }
      if (/INSERT INTO task_events/.test(sql)) { db.events += 1; return { rowCount: 1, rows: [] }; }
      if (/^\s*COMMIT/.test(sql)) {
        if (failCommitOnce && !commitFailed) { commitFailed = true; throw connError(); }
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    },
  };
}

// Финализация по образцу finalizeRole: гейт идемпотентности → запись → COMMIT.
async function finalizeLike(client) {
  await client.query('BEGIN');
  if (await isRunAlreadyFinalized(client, 'run1')) {
    await client.query('ROLLBACK');
    return { taskId: 't1', alreadyFinalized: true };
  }
  await client.query(`UPDATE agent_runs SET status = 'SUCCESS' WHERE id = $1`, ['run1']);
  await client.query(`INSERT INTO task_events (task_id) VALUES ($1)`, ['t1']);
  await client.query('COMMIT');
  return { taskId: 't1', finalized: true };
}

test('идемпотентность: обрыв на COMMIT первой попытки → повтор видит финализированный прогон, без дублей', async () => {
  const db = makeFakeDb();
  const claimClient = makeClient(db, { failCommitOnce: true }); // ack COMMIT «потерян»
  const freshClient = makeClient(db);
  const res = await finalizeWithConnRetry(finalizeLike, claimClient, null, {
    withFresh: (fn) => fn(freshClient),
    sleep: async () => {},
    backoff: [100, 200, 400],
  });
  assert.equal(res.alreadyFinalized, true, 'ретрай распознал уже финализированный прогон');
  assert.equal(db.runStatus, 'SUCCESS', 'результат прогона не потерян');
  assert.equal(db.events, 1, 'событие перехода НЕ задвоено (повторная финализация идемпотентна)');
});

test('идемпотентность: без обрыва финализация проходит с первой попытки (ровно одно событие)', async () => {
  const db = makeFakeDb();
  const res = await finalizeWithConnRetry(finalizeLike, makeClient(db), null, {
    withFresh: (fn) => fn(makeClient(db)),
    sleep: async () => {},
  });
  assert.equal(res.finalized, true);
  assert.equal(db.events, 1);
  assert.equal(db.runStatus, 'SUCCESS');
});
