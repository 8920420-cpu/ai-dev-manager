// APP-SETTINGS-001 — рантайм-настройки приложения (таблица app_settings,
// key-value). Редактируются в UI (раздел «Настройки → Выполнение») и читаются
// фоновым runner без перезапуска сервиса. Низкоуровневое чтение одного ключа
// (readAppSetting) живёт в db.js, чтобы runner не зависел от этого модуля.
import { withClient, clientConfig } from './db.js';

// Описание известных параметров: ключ в БД, дефолт и границы валидации.
export const APP_SETTING_SPECS = {
  orchestratorEnabled: { key: 'orchestrator_enabled', def: true },
  maxConcurrencyPerRole: { key: 'max_concurrency_per_role', def: 3, min: 1, max: 50 },
  // PROGRAMMER-PRIORITY-001: решение отменено. Ранее программист был зажат в РОВНО
  // 1 выделенный агент (def=min=max=1); теперь возвращён worktree-параллелизм до 3
  // одновременно работающих агентов по РАЗНЫМ сервисам (изначальный cap по
  // PROGRAMMER-WORKTREE-PER-SERVICE, миграция 0032). Задачи одного сервиса всё равно
  // сериализуются (один активный CODING на сервис), поэтому 3 агента идут по разным
  // сервисам и не конфликтуют в общем worktree. Границы [1..3] совпадают с жёстким
  // потолком MAX_CONCURRENCY в programmer-runner/bin/programmer-runner.js.
  programmerConcurrency: { key: 'programmer_concurrency', def: 3, min: 1, max: 3 },
  // TASK-AUTO-ACCEPT-001: «не проверять выполненные задачи». По умолчанию ВЫКЛЮЧЕНО —
  // дошедшие до DONE задачи ждут ручной приёмки через гейт «Проверка» (подраздел
  // «Задачи → Проверка»), accepted_at заполняется только после «Принять». Включите,
  // чтобы вернуть авто-приёмку: фоновый тик сразу помечает свежие DONE принятыми и
  // «Проверка» остаётся пустой. Значение хранится под ключом app_settings 'auto_accept_done'.
  autoAcceptDone: { key: 'auto_accept_done', def: false },
};

// Привести значение к целому в допустимых границах (иначе — дефолт спеки).
function clampInt(value, spec) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

function boolValue(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(v)) return true;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

// Собрать настройки из строк app_settings (Map key→value) в объект для клиента.
function shape(byKey) {
  const pick = (spec) => clampInt(byKey.has(spec.key) ? byKey.get(spec.key) : spec.def, spec);
  return {
    orchestratorEnabled: boolValue(
      byKey.has(APP_SETTING_SPECS.orchestratorEnabled.key)
        ? byKey.get(APP_SETTING_SPECS.orchestratorEnabled.key)
        : APP_SETTING_SPECS.orchestratorEnabled.def,
      APP_SETTING_SPECS.orchestratorEnabled.def,
    ),
    maxConcurrencyPerRole: pick(APP_SETTING_SPECS.maxConcurrencyPerRole),
    programmerConcurrency: pick(APP_SETTING_SPECS.programmerConcurrency),
    autoAcceptDone: boolValue(
      byKey.has(APP_SETTING_SPECS.autoAcceptDone.key)
        ? byKey.get(APP_SETTING_SPECS.autoAcceptDone.key)
        : APP_SETTING_SPECS.autoAcceptDone.def,
      APP_SETTING_SPECS.autoAcceptDone.def,
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
  if (patch && patch.orchestratorEnabled !== undefined) {
    updates[APP_SETTING_SPECS.orchestratorEnabled.key] = boolValue(
      patch.orchestratorEnabled,
      APP_SETTING_SPECS.orchestratorEnabled.def,
    );
  }
  if (patch && patch.maxConcurrencyPerRole !== undefined) {
    updates[APP_SETTING_SPECS.maxConcurrencyPerRole.key] = clampInt(
      patch.maxConcurrencyPerRole, APP_SETTING_SPECS.maxConcurrencyPerRole,
    );
  }
  if (patch && patch.programmerConcurrency !== undefined) {
    updates[APP_SETTING_SPECS.programmerConcurrency.key] = clampInt(
      patch.programmerConcurrency, APP_SETTING_SPECS.programmerConcurrency,
    );
  }
  if (patch && patch.autoAcceptDone !== undefined) {
    updates[APP_SETTING_SPECS.autoAcceptDone.key] = boolValue(
      patch.autoAcceptDone, APP_SETTING_SPECS.autoAcceptDone.def,
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

// PUT /api/app-settings — частичное обновление. Принимает
// {orchestratorEnabled, maxConcurrencyPerRole, programmerConcurrency, autoAcceptDone}.
// Валидирует/клампит значения, делает upsert по ключам и возвращает итоговый набор.
export async function updateAppSettings(s, patch) {
  return withClient(clientConfig(s), (c) => updateAppSettingsTx(c, patch));
}
