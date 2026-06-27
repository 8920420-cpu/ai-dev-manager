// APP-SETTINGS-001 — рантайм-настройки приложения (таблица app_settings,
// key-value). Редактируются в UI (раздел «Настройки → Выполнение») и читаются
// фоновым runner без перезапуска сервиса. Низкоуровневое чтение одного ключа
// (readAppSetting) живёт в db.js, чтобы runner не зависел от этого модуля.
import { withClient, clientConfig } from './db.js';

// Описание известных параметров: ключ в БД, дефолт и границы валидации.
export const APP_SETTING_SPECS = {
  maxConcurrencyPerRole: { key: 'max_concurrency_per_role', def: 3, min: 1, max: 50 },
};

// Привести значение к целому в допустимых границах (иначе — дефолт спеки).
function clampInt(value, spec) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

// Собрать настройки из строк app_settings (Map key→value) в объект для клиента.
function shape(byKey) {
  return {
    maxConcurrencyPerRole: clampInt(
      byKey.has(APP_SETTING_SPECS.maxConcurrencyPerRole.key)
        ? byKey.get(APP_SETTING_SPECS.maxConcurrencyPerRole.key)
        : APP_SETTING_SPECS.maxConcurrencyPerRole.def,
      APP_SETTING_SPECS.maxConcurrencyPerRole,
    ),
  };
}

async function readAll(c) {
  const r = await c.query('SELECT key, value FROM app_settings');
  return new Map(r.rows.map((row) => [row.key, row.value]));
}

export async function getAppSettingsTx(c) {
  return shape(await readAll(c));
}

export async function updateAppSettingsTx(c, patch) {
  const updates = {};
  if (patch && patch.maxConcurrencyPerRole !== undefined) {
    updates[APP_SETTING_SPECS.maxConcurrencyPerRole.key] = clampInt(
      patch.maxConcurrencyPerRole, APP_SETTING_SPECS.maxConcurrencyPerRole,
    );
  }
  for (const [key, value] of Object.entries(updates)) {
    await c.query(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
  return shape(await readAll(c));
}

// GET /api/app-settings — текущие рантайм-настройки приложения.
export async function getAppSettings(s) {
  return withClient(clientConfig(s), (c) => getAppSettingsTx(c));
}

// PUT /api/app-settings — частичное обновление. Принимает {maxConcurrencyPerRole}.
// Валидирует/клампит значения, делает upsert по ключам и возвращает итоговый набор.
export async function updateAppSettings(s, patch) {
  return withClient(clientConfig(s), (c) => updateAppSettingsTx(c, patch));
}
