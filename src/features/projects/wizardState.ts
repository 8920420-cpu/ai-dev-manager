/** Состояние и редьюсер мастера создания/редактирования проекта. */
import { makeId } from '../../lib/format';
import {
  DEFAULT_STAGE_ROLE_MAP,
  PRESET_ROLES,
  PRESET_STAGE_NAMES,
  roleCanonicalCode,
} from '../../data/presets';
import type { Project, ProjectStatus, Role, Stage, StageKind } from '../../types/project';

/** Стабильный ключ узла (UUID) для ссылок рёбер блок-схемы. */
function newStageKey(): string {
  // crypto.randomUUID есть в браузере и в node (jsdom-тесты) — даёт UUID-формат,
  // который требует backend (normalizeKey). Фолбэк на случай отсутствия.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : makeId('key').replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32)
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}

export interface WizardState {
  name: string;
  path: string;
  status: ProjectStatus;
  roles: Role[];
  stages: Stage[];
}

export type WizardAction =
  | { type: 'setName'; value: string }
  | { type: 'setPath'; value: string }
  | { type: 'setStatus'; value: ProjectStatus }
  | { type: 'addStage' }
  | { type: 'addNode'; kind: StageKind }
  | { type: 'removeStage'; stageId: string }
  | { type: 'renameStage'; stageId: string; name: string }
  | { type: 'reorderStage'; from: number; to: number }
  | { type: 'setStageRole'; stageId: string; roleId: string | null }
  | { type: 'setStageEnabled'; stageId: string; enabled: boolean }
  | { type: 'setStageScanPath'; stageId: string; scanPath: string }
  | { type: 'setStageStatus'; stageId: string; taskStatus: string }
  | { type: 'setStageJoinKey'; stageId: string; joinKey: string | null }
  | { type: 'applyDefaultStages' }
  | { type: 'addRole'; name: string }
  | { type: 'removeRole'; roleId: string }
  | { type: 'reset'; state: WizardState };

/**
 * Построить этапы пайплайна в стандартном порядке (PRESET_STAGE_NAMES) с ролями
 * по умолчанию (DEFAULT_STAGE_ROLE_MAP). Роли сопоставляются с переданным списком
 * по каноническому коду — это устойчиво к переименованию ролей пользователем.
 * Если подходящей роли в списке нет, этап остаётся без роли.
 */
export function buildPresetStages(roles: Role[]): Stage[] {
  const roleIdByCode = new Map<string, string>();
  for (const r of roles) {
    const code = roleCanonicalCode(r);
    if (code && !roleIdByCode.has(code)) roleIdByCode.set(code, r.id);
  }

  return PRESET_STAGE_NAMES.map((name) => {
    const mappedNames = DEFAULT_STAGE_ROLE_MAP[name] ?? [];
    const roleIds: string[] = [];
    for (const roleName of mappedNames) {
      const code = roleCanonicalCode({ name: roleName });
      const id = code ? roleIdByCode.get(code) : undefined;
      if (id) roleIds.push(id);
    }
    // Новые этапы по умолчанию включены.
    return { id: makeId('stage'), name, roleIds, enabled: true };
  });
}

/** Построить начальное состояние из пресетов этапов/ролей. */
export function buildPresetState(): WizardState {
  const roles: Role[] = PRESET_ROLES.map((r) => ({
    id: makeId('role'),
    name: r.name,
    code: r.code,
  }));

  return {
    name: '',
    path: '',
    status: 'active',
    roles,
    stages: buildPresetStages(roles),
  };
}

/** Построить состояние из существующего проекта (для редактирования). */
export function buildStateFromProject(project: Project): WizardState {
  return {
    name: project.name,
    path: project.path,
    status: project.status,
    // Бэкафилл канонического кода для ролей старых данных (по точному пресетному имени).
    roles: project.roles.map((r) => ({ ...r, code: roleCanonicalCode(r) ?? r.code })),
    stages: project.stages.map((s) => ({
      ...s,
      roleIds: [...s.roleIds],
      enabled: s.enabled,
    })),
  };
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'setName':
      return { ...state, name: action.value };
    case 'setPath':
      return { ...state, path: action.value };
    case 'setStatus':
      return { ...state, status: action.value };
    case 'addStage':
      return {
        ...state,
        stages: [
          ...state.stages,
          { id: makeId('stage'), kind: 'stage', stageKey: newStageKey(), name: '', roleIds: [], enabled: true },
        ],
      };
    case 'addNode': {
      // FORK-JOIN-001: добавить управляющий узел (fork/join/condition) или этап.
      const labels: Record<StageKind, string> = {
        stage: '',
        fork: 'Разделить',
        join: 'Объединить',
        condition: 'Условие',
      };
      return {
        ...state,
        stages: [
          ...state.stages,
          {
            id: makeId('stage'),
            kind: action.kind,
            stageKey: newStageKey(),
            name: labels[action.kind],
            roleIds: [],
            enabled: true,
          },
        ],
      };
    }
    case 'removeStage':
      return {
        ...state,
        stages: state.stages.filter((s) => s.id !== action.stageId),
      };
    case 'renameStage':
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.id === action.stageId ? { ...s, name: action.name } : s,
        ),
      };
    case 'reorderStage': {
      const { from, to } = action;
      if (
        from === to ||
        from < 0 ||
        to < 0 ||
        from >= state.stages.length ||
        to >= state.stages.length
      ) {
        return state;
      }
      const stages = [...state.stages];
      const [moved] = stages.splice(from, 1);
      if (!moved) return state;
      stages.splice(to, 0, moved);
      return { ...state, stages };
    }
    case 'setStageRole':
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.id === action.stageId
            ? { ...s, roleIds: action.roleId ? [action.roleId] : [] }
            : s,
        ),
      };
    case 'setStageEnabled':
      return {
        ...state,
        stages: state.stages.map((s) =>
          // Переключаем только флаг; scanPath, роль, позиция и прочие настройки сохраняются.
          s.id === action.stageId ? { ...s, enabled: action.enabled } : s,
        ),
      };
    case 'setStageScanPath':
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.id === action.stageId ? { ...s, scanPath: action.scanPath } : s,
        ),
      };
    case 'setStageStatus':
      return {
        ...state,
        stages: state.stages.map((s) =>
          // Пустой выбор → снять статус (undefined), иначе сохранить выбранный.
          s.id === action.stageId
            ? { ...s, taskStatus: action.taskStatus || undefined }
            : s,
        ),
      };
    case 'setStageJoinKey':
      // FORK-JOIN-001: для узла fork — выбор парного join (по его stageKey).
      // Пустой выбор → снять привязку (undefined): deriveSchemeEdges откатится
      // на позиционный «ближайший join справа».
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.id === action.stageId ? { ...s, joinKey: action.joinKey || undefined } : s,
        ),
      };
    case 'applyDefaultStages':
      // Пересобрать этапы в стандартном порядке с ролями по умолчанию.
      // Роли проекта сохраняются как есть; перезаписываются только этапы.
      return { ...state, stages: buildPresetStages(state.roles) };
    case 'addRole': {
      const name = action.name.trim();
      if (!name) return state;
      return {
        ...state,
        roles: [...state.roles, { id: makeId('role'), name }],
      };
    }
    case 'removeRole':
      return {
        ...state,
        roles: state.roles.filter((r) => r.id !== action.roleId),
        stages: state.stages.map((s) => ({
          ...s,
          roleIds: s.roleIds.filter((id) => id !== action.roleId),
        })),
      };
    case 'reset':
      return action.state;
    default:
      return state;
  }
}

/** Признак «грязной» формы: введены данные или не первый шаг. */
export function isDirty(state: WizardState, initial: WizardState, step: number): boolean {
  if (step !== 0) return true;
  if (state.name.trim().length > 0) return true;
  if (state.path.trim().length > 0) return true;
  return JSON.stringify(state.stages) !== JSON.stringify(initial.stages);
}
