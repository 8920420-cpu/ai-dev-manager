// APP-SETTINGS-001 — рантайм-настройки приложения (таблица app_settings,
// key-value). Редактируются в UI (раздел «Настройки → Выполнение») и читаются
// фоновым runner без перезапуска сервиса. Низкоуровневое чтение одного ключа
// (readAppSetting) живёт в db.js, чтобы runner не зависел от этого модуля.
import { withClient, clientConfig } from './db.js';

// Описание известных параметров: ключ в БД, дефолт и границы валидации.
export const APP_SETTING_SPECS = {
  maxConcurrencyPerRole: { key: 'max_concurrency_per_role', def: 3, min: 1, max: 50 },
  // Сколько задач PROGRAMMER (стадия CODING) исполнитель ведёт параллельно.
  // Каждая идёт в worktree своего микросервиса. Жёсткий потолок — 3.
  programmerConcurrency: { key: 'programmer_concurrency', def: 3, min: 1, max: 3 },
};

// ROLE-ENGINE-ROUTING-001: карта «рассуждающая роль → движок исполнения».
// Три движка: 'deepseek' (внутренний tool-loop оркестратора, дефолт), 'codex' и
// 'claude_code' (хостовые драйверы через generic-контракт next-reasoning-task).
// Хранится как JSON-объект { ROLE_CODE: engine }. Отсутствие записи = 'deepseek'.
// Допустимы только рассуждающие роли — оркестратор сверяет с LLM_ROLE_CODES.
export const ROLE_ENGINES_SPEC = { key: 'role_engines', def: {} };
export const ENGINES = ['deepseek', 'codex', 'claude_code'];
// Хостовые движки (внешние драйверы): такие роли исключаются из внутреннего цикла.
export const EXTERNAL_ENGINES = ['codex', 'claude_code'];
const KNOWN_REASONING_ROLES = new Set([
  'TASK_INTAKE_OFFICER', 'ARCHITECT', 'DECOMPOSER', 'TASK_REVIEWER',
  'FAILURE_ANALYST', 'DOCUMENTATION_AUDITOR', 'DOCUMENTATION_KEEPER',
]);

// Привести значение к карте «известная роль → допустимый движок». Записи с
// движком 'deepseek' опускаем (это дефолт — карта хранит только делегирования).
function cleanRoleEngines(value) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  for (const [role, engine] of Object.entries(src)) {
    const r = String(role).trim().toUpperCase();
    const e = String(engine).trim().toLowerCase();
    if (KNOWN_REASONING_ROLES.has(r) && ENGINES.includes(e) && e !== 'deepseek') out[r] = e;
  }
  return out;
}

// Привести значение к целому в допустимых границах (иначе — дефолт спеки).
function clampInt(value, spec) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return spec.def;
  return Math.min(spec.max, Math.max(spec.min, n));
}

// Собрать настройки из строк app_settings (Map key→value) в объект для клиента.
function shape(byKey) {
  const pick = (spec) => clampInt(byKey.has(spec.key) ? byKey.get(spec.key) : spec.def, spec);
  const enginesKey = ROLE_ENGINES_SPEC.key;
  return {
    maxConcurrencyPerRole: pick(APP_SETTING_SPECS.maxConcurrencyPerRole),
    programmerConcurrency: pick(APP_SETTING_SPECS.programmerConcurrency),
    roleEngines: cleanRoleEngines(byKey.has(enginesKey) ? byKey.get(enginesKey) : ROLE_ENGINES_SPEC.def),
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
  if (patch && patch.programmerConcurrency !== undefined) {
    updates[APP_SETTING_SPECS.programmerConcurrency.key] = clampInt(
      patch.programmerConcurrency, APP_SETTING_SPECS.programmerConcurrency,
    );
  }
  if (patch && patch.roleEngines !== undefined) {
    updates[ROLE_ENGINES_SPEC.key] = cleanRoleEngines(patch.roleEngines);
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
// {maxConcurrencyPerRole, programmerConcurrency}. Валидирует/клампит значения,
// делает upsert по ключам и возвращает итоговый набор.
export async function updateAppSettings(s, patch) {
  return withClient(clientConfig(s), (c) => updateAppSettingsTx(c, patch));
}
