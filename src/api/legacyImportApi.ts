/**
 * Одноразовый перенос бизнес-данных из localStorage (legacy) в каноническое
 * серверное хранилище через `POST /api/import/legacy`.
 *
 * Читает старые ключи localStorage напрямую (adm.projects/adm.databases/
 * adm.roleConnections), формирует payload БЕЗ секретов и отправляет:
 *   - dryRun:true  → предпросмотр плана (ничего не пишет);
 *   - dryRun:false → коммит (идемпотентно по migrationKey + естественным ключам).
 *
 * Авто-импорт ЗАПРЕЩЁН: запускается только явным действием пользователя.
 * Секреты (пароли БД, токены) НЕ читаются и НЕ отправляются.
 */
import { http } from './http';
import { roleCanonicalCode } from '../data/presets';

/** Стабильный ключ миграции — идемпотентность повторных запусков. */
export const MIGRATION_KEY = 'legacy-localstore-v1';

/** Флаг «импорт уже выполнен» — чтобы не предлагать его повторно. */
const IMPORT_DONE_KEY = 'adm.import.done';

const PREFIX = 'adm.';

function rawRead<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// --- Формы legacy-данных в localStorage ------------------------------------

interface LegacyStage {
  id: string;
  name: string;
  roleIds?: string[];
  enabled?: boolean;
  scanPath?: string;
}
interface LegacyRole {
  id: string;
  name: string;
  code?: string;
}
interface LegacyProject {
  id: string;
  name: string;
  path: string;
  status?: string;
  stages?: LegacyStage[];
  roles?: LegacyRole[];
  databaseId?: string;
}
interface LegacyDatabase {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode?: string;
}
interface LegacyRoleConnection {
  id: string;
  role: string;
  integrationId?: string;
}

// --- Payload импорта (контракт сервера) ------------------------------------

export interface ImportPayload {
  migrationKey: string;
  dryRun: boolean;
  projects: unknown[];
  additionalDatabases: unknown[];
  roleConnectors: unknown[];
}

export interface ImportResult {
  migrationKey: string;
  dryRun: boolean;
  created: Record<string, number>;
  conflicts: unknown[];
  skipped: unknown[];
}

/** Есть ли вообще legacy-данные для переноса. */
export function hasLegacyData(): boolean {
  const p = rawRead<LegacyProject[]>('projects', []);
  const d = rawRead<LegacyDatabase[]>('databases', []);
  const r = rawRead<LegacyRoleConnection[]>('roleConnections', []);
  return p.length > 0 || d.length > 0 || r.length > 0;
}

export function isImportDone(): boolean {
  try {
    return localStorage.getItem(IMPORT_DONE_KEY) === 'true';
  } catch {
    return false;
  }
}

function markImportDone(): void {
  try {
    localStorage.setItem(IMPORT_DONE_KEY, 'true');
  } catch {
    /* квота/приватный режим — тихо игнорируем */
  }
}

/** Преобразовать legacy-этап в серверный контракт (roleIds → roleCodes). */
function mapStage(stage: LegacyStage, roles: LegacyRole[]) {
  const roleById = new Map(roles.map((r) => [r.id, r]));
  const roleCodes = (stage.roleIds ?? [])
    .map((id) => {
      const role = roleById.get(id);
      return role ? roleCanonicalCode(role) : undefined;
    })
    .filter((c): c is string => Boolean(c));
  return {
    name: stage.name,
    enabled: stage.enabled !== false,
    scanner: { watchDirectory: stage.scanPath ?? '' },
    roleCodes,
  };
}

/** Собрать payload из legacy localStorage. Секреты не читаются. */
export function buildPayload(dryRun: boolean): ImportPayload {
  const projects = rawRead<LegacyProject[]>('projects', []);
  const databases = rawRead<LegacyDatabase[]>('databases', []);
  const roleConnections = rawRead<LegacyRoleConnection[]>('roleConnections', []);

  return {
    migrationKey: MIGRATION_KEY,
    dryRun,
    projects: projects.map((p) => ({
      name: p.name,
      path: p.path,
      status: p.status ?? 'active',
      databaseId: p.databaseId ?? null,
      stages: (p.stages ?? []).map((s) => mapStage(s, p.roles ?? [])),
    })),
    // Пароли НЕ переносятся — отправляем только несекретные поля.
    additionalDatabases: databases.map((d) => ({
      name: d.name,
      host: d.host,
      port: d.port,
      database: d.database,
      user: d.user,
      sslMode: d.sslMode ?? 'disable',
    })),
    roleConnectors: roleConnections
      .filter((rc) => rc.role && rc.role.trim())
      .map((rc) => ({
        // Legacy хранил отображаемое имя роли — восстанавливаем канонический код.
        roleCode: roleCanonicalCode({ name: rc.role.trim() }) ?? rc.role.trim(),
        connectorId: rc.integrationId?.trim() || null,
      })),
  };
}

export const legacyImportApi = {
  hasLegacyData,
  isImportDone,
  MIGRATION_KEY,

  /** Предпросмотр (ничего не пишет на сервере). */
  async preview(): Promise<ImportResult> {
    return http.post<ImportResult>('/api/import/legacy', buildPayload(true));
  },

  /** Коммит переноса. Помечает импорт завершённым. */
  async commit(): Promise<ImportResult> {
    const res = await http.post<ImportResult>('/api/import/legacy', buildPayload(false));
    markImportDone();
    return res;
  },
};
