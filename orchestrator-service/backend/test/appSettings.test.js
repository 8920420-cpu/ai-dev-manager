// APP-SETTINGS-001 — тесты рантайм-настроек (клампинг + upsert + дефолты).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAppSettingsTx, updateAppSettingsTx } from '../src/appSettings.js';

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

test('getAppSettings: значение из БД', async () => {
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 2, rows: [{ key: 'max_concurrency_per_role', value: 7 }, { key: 'orchestrator_enabled', value: false }] } },
  ]);
  const s = await getAppSettingsTx(c);
  assert.equal(s.maxConcurrencyPerRole, 7);
  assert.equal(s.orchestratorEnabled, false);
});

test('getAppSettings: пустая таблица → дефолт 3', async () => {
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  const s = await getAppSettingsTx(c);
  assert.equal(s.orchestratorEnabled, true);
  assert.equal(s.maxConcurrencyPerRole, 3);
  // PROGRAMMER-PRIORITY-001: программист зафиксирован на ровно 1 выделенном агенте.
  assert.equal(s.programmerConcurrency, 1);
});

test('orchestratorEnabled: сохраняется как boolean', async () => {
  const c = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 1, rows: [{ key: 'orchestrator_enabled', value: false }] } },
  ]);
  const s = await updateAppSettingsTx(c, { orchestratorEnabled: false });
  assert.equal(s.orchestratorEnabled, false);
  const upsert = c.calls.find((q) => /INSERT INTO app_settings/.test(q.sql));
  assert.equal(upsert.params[0], 'orchestrator_enabled');
  assert.equal(upsert.params[1], 'false');
});

test('programmerConcurrency: зафиксирован на 1 (PROGRAMMER-PRIORITY-001)', async () => {
  // Старое значение из БД (2) читается как 1 — потолок опущен до 1.
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 1, rows: [{ key: 'programmer_concurrency', value: 2 }] } },
  ]);
  assert.equal((await getAppSettingsTx(c)).programmerConcurrency, 1);

  const high = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  await updateAppSettingsTx(high, { programmerConcurrency: 9 });
  const upsert = high.calls.find((q) => /INSERT/.test(q.sql));
  assert.equal(upsert.params[0], 'programmer_concurrency');
  assert.equal(upsert.params[1], '1', 'любое значение клампится до фиксированного 1');
});

test('updateAppSettings: валидное значение → upsert и возврат', async () => {
  const c = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 1, rows: [{ key: 'max_concurrency_per_role', value: 5 }] } },
  ]);
  const s = await updateAppSettingsTx(c, { maxConcurrencyPerRole: 5 });
  assert.equal(s.maxConcurrencyPerRole, 5);
  const upsert = c.calls.find((q) => /INSERT INTO app_settings/.test(q.sql));
  assert.ok(upsert, 'был upsert');
  assert.equal(upsert.params[0], 'max_concurrency_per_role');
  assert.equal(upsert.params[1], '5', 'значение сериализовано в JSON');
});

test('updateAppSettings: значение вне границ клампится (0 → 1, 999 → 50)', async () => {
  const low = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: (h) => ({ rowCount: 1, rows: [{ key: 'max_concurrency_per_role', value: 1 }] }) },
  ]);
  await updateAppSettingsTx(low, { maxConcurrencyPerRole: 0 });
  assert.equal(low.calls.find((q) => /INSERT/.test(q.sql)).params[1], '1');

  const high = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  await updateAppSettingsTx(high, { maxConcurrencyPerRole: 999 });
  assert.equal(high.calls.find((q) => /INSERT/.test(q.sql)).params[1], '50');
});

test('autoAcceptDone: дефолт true, читается из БД, сохраняется как boolean', async () => {
  // Пустая таблица → дефолт true.
  const empty = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  assert.equal((await getAppSettingsTx(empty)).autoAcceptDone, true);

  // Значение из БД (false).
  const off = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 1, rows: [{ key: 'auto_accept_done', value: false }] } },
  ]);
  assert.equal((await getAppSettingsTx(off)).autoAcceptDone, false);

  // Патч сохраняется как boolean-строка.
  const upd = fakeClient([
    { re: /INSERT INTO app_settings/, reply: { rowCount: 1, rows: [] } },
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  await updateAppSettingsTx(upd, { autoAcceptDone: false });
  const upsert = upd.calls.find((q) => /INSERT INTO app_settings/.test(q.sql));
  assert.equal(upsert.params[0], 'auto_accept_done');
  assert.equal(upsert.params[1], 'false');
});

test('updateAppSettings: пустой патч → без upsert', async () => {
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  await updateAppSettingsTx(c, {});
  assert.equal(c.calls.some((q) => /INSERT INTO app_settings/.test(q.sql)), false);
});
