/** Типы настроек: соответствие ролей коннекторам и подключение к PostgreSQL. */

/**
 * Карточка роли пайплайна — канонический контракт оркестратора
 * (`/api/roles/*`, см. orchestrator-service/backend/docs/api-roles.md).
 * Идентичность роли — её `code`; `name`/`code` через API не меняются.
 * `groupId` — id смысловой группы роли (`role_groups`) или null = «Прочее».
 * Раскладка по группам — только организация экрана ролей и не влияет на рантайм
 * (пропуск роли настраивается per-project в «Этапы пайплайна»).
 * `prompt: ''` означает файловый fallback.
 */
export interface RoleCard {
  code: string;
  name: string;
  description: string;
  /** Рабочий промт; '' = используется файловый roles/<role>.md. */
  prompt: string;
  /** id смысловой группы (`role_groups`) или null = «Прочее». */
  groupId: string | null;
  /** Упорядоченные стабильные относительные id skill-файлов (POSIX-слэши). */
  skills: string[];
}

/** Частичное обновление карточки роли (PUT /api/roles/:code). */
export type RoleCardPatch = Partial<Pick<RoleCard, 'description' | 'prompt' | 'skills' | 'groupId'>>;

/**
 * Смысловая группа ролей (`/api/role-groups`, ROLE-GROUPS-001) — управляемая
 * сущность: создание/переименование/удаление. Роли распределяются по группам на
 * экране «Настройки → Роли»; роль без группы попадает в «Прочее».
 */
export interface RoleGroup {
  id: string;
  name: string;
  sortOrder: number;
}

/** Уровни доступа роли (чекбоксы карточки роли). */
export type ToolCapability = 'read' | 'modify' | 'create' | 'delete' | 'execute';

export const TOOL_CAPABILITIES: ToolCapability[] = ['read', 'modify', 'create', 'delete', 'execute'];

export const TOOL_CAPABILITY_LABEL: Record<ToolCapability, string> = {
  read: 'Читать',
  modify: 'Изменять',
  create: 'Создавать',
  delete: 'Удалять',
  execute: 'Выполнять команды',
};

/** Инструмент реестра: builtin (по уровню доступа) или mcp (MCP-сервер). */
export interface Tool {
  id: string;
  name: string;
  kind: 'builtin' | 'mcp';
  /** Уровень доступа builtin-инструмента. */
  capability: ToolCapability;
  description: string;
  /** Для mcp: { command,args,env } или { url,transport,headers }. */
  config: Record<string, unknown>;
}

/** Полезная нагрузка создания/обновления инструмента. */
export interface ToolInput {
  name: string;
  kind: 'builtin' | 'mcp';
  capability?: ToolCapability;
  description?: string;
  config?: Record<string, unknown>;
}

/** Доступный skill-файл из каталога skills сервера (GET /api/skills). */
export interface SkillFile {
  /** Стабильный относительный id внутри каталога (напр. `group/a.md`). */
  id: string;
  /** Отображаемое имя файла. */
  name: string;
}

/** Назначение: роль → интеграция (коннектор). */
export interface RoleConnection {
  id: string;
  /** Название роли, напр. «Разработчик». */
  role: string;
  /** id интеграции из раздела «Интеграции» (или '' если не выбрано). */
  integrationId: string;
}

/** Поддерживаемые СУБД подключения. */
export type DbmsType = 'postgres';

export const DBMS_LABEL: Record<DbmsType, string> = {
  postgres: 'PostgreSQL',
};

/**
 * Единая пользовательская модель подключения к БД — канонический контракт
 * оркестратора `/api/database-connections` (DATABASE-CONNECTIONS-001, см.
 * orchestrator-service/backend/docs/api-database-connections.md).
 *
 * НЕТ категорий «основная»/«дополнительная». Секрет (пароль) НИКОГДА не
 * возвращается сервером: вместо него приходит флаг `hasSecret`. Пароль
 * передаётся только в теле create/update в момент действия пользователя.
 */
export interface DbConnection {
  id: string;
  /** Понятное имя подключения, напр. «Каталог-БД». */
  name: string;
  dbmsType: DbmsType;
  host: string;
  port: number;
  database: string;
  user: string;
  sslMode: PgSslMode;
  /** Установлен ли пароль на сервере (сам секрет не возвращается). */
  hasSecret: boolean;
  createdAt?: string;
  updatedAt?: string;
}

/** Результат проверки соединения (POST /api/database-connections/:id/test). */
export interface DbConnectionTestResult {
  connected: boolean;
  /** Безопасный класс ошибки без реквизитов, либо null при успехе. */
  error: string | null;
}

/** Зависимый проект при конфликте удаления используемого подключения. */
export interface DbConnectionDependent {
  id: string;
  code: string;
  name: string;
}

export type PgSslMode = 'disable' | 'require' | 'verify-full';

export const PG_SSL_LABEL: Record<PgSslMode, string> = {
  disable: 'Выключен',
  require: 'Требуется (require)',
  'verify-full': 'Проверка сертификата (verify-full)',
};

/**
 * Настройки подключения к PostgreSQL — БЕЗ пароля.
 * Контракт совпадает с backend `redactSettings`: сервер никогда не отдаёт
 * пароль клиенту, вместо него приходит флаг `hasPassword`.
 */
export interface PgSettings {
  host: string;
  port: number;
  database: string;
  user: string;
  /** Служебная БД для CREATE DATABASE (есть в backend). */
  adminDatabase: string;
  sslMode: PgSslMode;
  /** Установлен ли пароль на сервере (пароль сам не передаётся). */
  hasPassword: boolean;
}

/**
 * Данные формы PostgreSQL. Пароль присутствует ТОЛЬКО в момент отправки на
 * backend и никогда не сохраняется в localStorage и не логируется.
 * Пустой пароль при сохранении = «не менять сохранённый» (см. backend mergeSettings).
 */
export interface PgFormValues {
  host: string;
  port: string;
  database: string;
  user: string;
  adminDatabase: string;
  sslMode: PgSslMode;
  password: string;
}
