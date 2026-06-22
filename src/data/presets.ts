/** Пресеты этапов и ролей для мастера создания проекта. */

// Последовательность этапов по умолчанию (пользователь может изменить в любой момент):
// Architect → Decomposer → Programmer → Scanner → Task Reviewer → Pipeline Service →
// Failure Analyst (только если ошибка) → Documentation Auditor →
// Documentation Keeper (если нужен) → Git Integrator → Done.
export const PRESET_STAGE_NAMES = [
  'Architect',
  'Decomposer',
  'Programmer',
  'Scanner',
  'Task Reviewer',
  'Pipeline Service',
  'Failure Analyst (только если ошибка)',
  'Documentation Auditor',
  'Documentation Keeper (если нужен)',
  'Git Integrator',
  'Done',
] as const;

export const PRESET_ROLE_NAMES = [
  'Architect',
  'Decomposer',
  'Programmer',
  'Scanner',
  'Task Reviewer',
  'Pipeline Service',
  'Failure Analyst',
  'Documentation Auditor',
  'Documentation Keeper',
  'Git Integrator',
] as const;

/** Роль сканера отслеживает конкретную папку — для неё показываем выбор папки. */
export function isScannerRole(name: string): boolean {
  const n = name.trim().toLocaleLowerCase('ru-RU');
  return n.includes('scanner') || n.includes('сканер');
}

/** Рекомендованное соответствие «этап → роль» по умолчанию. */
export const DEFAULT_STAGE_ROLE_MAP: Record<string, string[]> = {
  Architect: ['Architect'],
  Decomposer: ['Decomposer'],
  Programmer: ['Programmer'],
  Scanner: ['Scanner'],
  'Task Reviewer': ['Task Reviewer'],
  'Pipeline Service': ['Pipeline Service'],
  'Failure Analyst (только если ошибка)': ['Failure Analyst'],
  'Documentation Auditor': ['Documentation Auditor'],
  'Documentation Keeper (если нужен)': ['Documentation Keeper'],
  'Git Integrator': ['Git Integrator'],
  // «Done» — терминальный этап без роли.
  Done: [],
};
