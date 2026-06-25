/** Пресеты этапов и ролей для мастера создания проекта. */

// Последовательность этапов по умолчанию (пользователь может изменить в любой момент):
// Task Intake Officer → Architect → Decomposer → Programmer → Task Reviewer →
// Pipeline Service → Failure Analyst (только если ошибка) → Documentation Auditor →
// Documentation Keeper (если нужен) → Git Integrator → Done.
// Scanner в движение по ролям НЕ входит: это отдельная роль-приёмник из папок.
export const PRESET_STAGE_NAMES = [
  'Task Intake Officer',
  'Architect',
  'Decomposer',
  'Programmer',
  'Task Reviewer',
  'Pipeline Service',
  'Failure Analyst (только если ошибка)',
  'Documentation Auditor',
  'Documentation Keeper (если нужен)',
  'Git Integrator',
  'Done',
] as const;

/**
 * Пресет ролей с каноническими кодами контракта оркестратора. Код — единственный
 * надёжный признак роли; отображаемое `name` не используется для логики.
 */
export const PRESET_ROLES = [
  { name: 'Task Intake Officer', code: 'TASK_INTAKE_OFFICER' },
  { name: 'Architect', code: 'ARCHITECT' },
  { name: 'Decomposer', code: 'DECOMPOSER' },
  { name: 'Programmer', code: 'PROGRAMMER' },
  { name: 'Scanner', code: 'SCANNER' },
  { name: 'Task Reviewer', code: 'TASK_REVIEWER' },
  { name: 'Pipeline Service', code: 'PIPELINE_SERVICE' },
  { name: 'Failure Analyst', code: 'FAILURE_ANALYST' },
  { name: 'Documentation Auditor', code: 'DOCUMENTATION_AUDITOR' },
  { name: 'Documentation Keeper', code: 'DOCUMENTATION_KEEPER' },
  { name: 'Git Integrator', code: 'GIT_INTEGRATOR' },
] as const;

export const PRESET_ROLE_NAMES = PRESET_ROLES.map((r) => r.name);

/** Канонический код роли Scanner из контракта. */
export const SCANNER_ROLE_CODE = 'SCANNER';

/** Точное соответствие «пресетное имя → канонический код» (для бэкафилла старых данных). */
const PRESET_CODE_BY_NAME = new Map<string, string>(
  PRESET_ROLES.map((r) => [r.name, r.code]),
);

/**
 * Канонический код роли: берётся из самого поля `code`, а при его отсутствии —
 * однозначно восстанавливается по точному пресетному имени (миграция старых
 * локальных данных, созданных до появления кодов). Нечёткое сопоставление по
 * подстроке названия запрещено.
 */
export function roleCanonicalCode(role: { code?: string; name: string }): string | undefined {
  if (role.code && role.code.trim()) return role.code.trim();
  return PRESET_CODE_BY_NAME.get(role.name.trim());
}

/**
 * Роль сканера отслеживает конкретную папку — для неё показываем выбор папки.
 * Признак определяется ТОЛЬКО по каноническому коду `SCANNER`, не по названию.
 */
export function isScannerRole(role: { code?: string; name: string }): boolean {
  return roleCanonicalCode(role) === SCANNER_ROLE_CODE;
}

/** Рекомендованное соответствие «этап → роль» по умолчанию. */
export const DEFAULT_STAGE_ROLE_MAP: Record<string, string[]> = {
  'Task Intake Officer': ['Task Intake Officer'],
  Architect: ['Architect'],
  Decomposer: ['Decomposer'],
  Programmer: ['Programmer'],
  'Task Reviewer': ['Task Reviewer'],
  'Pipeline Service': ['Pipeline Service'],
  'Failure Analyst (только если ошибка)': ['Failure Analyst'],
  'Documentation Auditor': ['Documentation Auditor'],
  'Documentation Keeper (если нужен)': ['Documentation Keeper'],
  'Git Integrator': ['Git Integrator'],
  // «Done» — терминальный этап без роли.
  Done: [],
};
