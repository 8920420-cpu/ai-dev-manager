// Настройки подключения к БД оркестратора.
// Приоритет: сохранённый файл config/db.settings.json > переменные окружения > значения по умолчанию.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveInt } from './envConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const SETTINGS_PATH =
  process.env.ORCHESTRATOR_SETTINGS_PATH || resolve(__dirname, '../config/db.settings.json');

const DEFAULTS = {
  host: process.env.PGHOST || '127.0.0.1',
  port: resolveInt('PGPORT', 5432, { min: 1, max: 65535 }).value,
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || 'postgres',
  database: process.env.PGDATABASE || 'orchestrator_db',
  // Служебная БД, к которой подключаемся для CREATE DATABASE.
  adminDatabase: process.env.PGADMIN_DB || 'postgres',
};

function sanitize(s) {
  return {
    host: String(s.host ?? '127.0.0.1').trim() || '127.0.0.1',
    port: Number(s.port) || 5432,
    user: String(s.user ?? 'postgres').trim() || 'postgres',
    password: String(s.password ?? ''),
    database: String(s.database ?? 'orchestrator_db').trim() || 'orchestrator_db',
    adminDatabase: String(s.adminDatabase ?? 'postgres').trim() || 'postgres',
  };
}

// Разбор строки подключения вида postgresql://user:pass@host:port/db
export function parseConnectionString(url) {
  const u = new URL(url);
  if (!/^postgres(ql)?:$/.test(u.protocol)) {
    throw new Error('Ожидается строка postgresql://user:pass@host:port/database');
  }
  return {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 5432,
    user: decodeURIComponent(u.username) || 'postgres',
    password: decodeURIComponent(u.password) || '',
    database: u.pathname.replace(/^\//, '') || 'orchestrator_db',
  };
}

// Версия настроек без секрета — только её можно отдавать клиенту по сети.
// Пароль никогда не покидает сервер; вместо него передаём флаг hasPassword.
export function redactSettings(s) {
  const { password, ...rest } = s;
  return { ...rest, hasPassword: Boolean(password) };
}

// Слить базовые настройки с patch. Ключевое правило безопасности:
// пустой/отсутствующий password в patch означает «сохранить существующий»,
// потому что клиент никогда не получает пароль (см. redactSettings) и его
// пустое поле формы не должно затирать реальный секрет.
function mergeSettings(base, patch) {
  if (!patch || !Object.keys(patch).length) return { ...base };
  let merged = { ...base, ...patch };
  if (patch.url) merged = { ...merged, ...parseConnectionString(patch.url) };
  const patchHasPassword =
    (typeof patch.password === 'string' && patch.password !== '') ||
    (typeof merged.password === 'string' && merged.password !== '' && patch.url);
  if (!patchHasPassword) merged.password = base.password ?? '';
  return merged;
}

export async function loadSettings() {
  if (existsSync(SETTINGS_PATH)) {
    try {
      const raw = await readFile(SETTINGS_PATH, 'utf8');
      return sanitize({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {
      // битый файл — откатываемся на значения по умолчанию
    }
  }
  return { ...DEFAULTS };
}

export async function saveSettings(patch) {
  const next = sanitize(mergeSettings(await loadSettings(), patch));
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Слить сохранённые настройки с переданными (для предпросмотра без сохранения).
export async function resolveSettings(patch) {
  return sanitize(mergeSettings(await loadSettings(), patch));
}
