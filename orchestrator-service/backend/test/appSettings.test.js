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
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 1, rows: [{ key: 'max_concurrency_per_role', value: 7 }] } },
  ]);
  const s = await getAppSettingsTx(c);
  assert.equal(s.maxConcurrencyPerRole, 7);
});

test('getAppSettings: пустая таблица → дефолт 3', async () => {
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  const s = await getAppSettingsTx(c);
  assert.equal(s.maxConcurrencyPerRole, 3);
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

test('updateAppSettings: пустой патч → без upsert', async () => {
  const c = fakeClient([
    { re: /SELECT key, value FROM app_settings/, reply: { rowCount: 0, rows: [] } },
  ]);
  await updateAppSettingsTx(c, {});
  assert.equal(c.calls.some((q) => /INSERT INTO app_settings/.test(q.sql)), false);
});
