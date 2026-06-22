/** Состояние и редьюсер мастера создания/редактирования проекта. */
import { makeId } from '../../lib/format';
import {
  DEFAULT_STAGE_ROLE_MAP,
  PRESET_ROLE_NAMES,
  PRESET_STAGE_NAMES,
} from '../../data/presets';
import type { Project, ProjectStatus, Role, Stage } from '../../types/project';

export interface WizardState {
  name: string;
  path: string;
  status: ProjectStatus;
  roles: Role[];
  stages: Stage[];
  /** Выбранная БД (PRIMARY_DB_ID или id доп. подключения); null — не выбрана. */
  databaseId: string | null;
}

export type WizardAction =
  | { type: 'setName'; value: string }
  | { type: 'setPath'; value: string }
  | { type: 'setStatus'; value: ProjectStatus }
  | { type: 'addStage' }
  | { type: 'removeStage'; stageId: string }
  | { type: 'renameStage'; stageId: string; name: string }
  | { type: 'reorderStage'; from: number; to: number }
  | { type: 'setStageRole'; stageId: string; roleId: string | null }
  | { type: 'setStageScanPath'; stageId: string; scanPath: string }
  | { type: 'addRole'; name: string }
  | { type: 'removeRole'; roleId: string }
  | { type: 'setDatabase'; databaseId: string | null }
  | { type: 'reset'; state: WizardState };

/** Построить начальное состояние из пресетов этапов/ролей. */
export function buildPresetState(): WizardState {
  const roles: Role[] = PRESET_ROLE_NAMES.map((name) => ({ id: makeId('role'), name }));
  const roleIdByName = new Map(roles.map((r) => [r.name, r.id]));

  const stages: Stage[] = PRESET_STAGE_NAMES.map((name) => {
    const mappedNames = DEFAULT_STAGE_ROLE_MAP[name] ?? [];
    const roleIds: string[] = [];
    for (const roleName of mappedNames) {
      const id = roleIdByName.get(roleName);
      if (id) roleIds.push(id);
    }
    return { id: makeId('stage'), name, roleIds };
  });

  return { name: '', path: '', status: 'active', roles, stages, databaseId: null };
}

/** Построить состояние из существующего проекта (для редактирования). */
export function buildStateFromProject(project: Project): WizardState {
  return {
    name: project.name,
    path: project.path,
    status: project.status,
    roles: project.roles.map((r) => ({ ...r })),
    stages: project.stages.map((s) => ({ ...s, roleIds: [...s.roleIds] })),
    databaseId: project.databaseId ?? null,
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
        stages: [...state.stages, { id: makeId('stage'), name: '', roleIds: [] }],
      };
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
    case 'setStageScanPath':
      return {
        ...state,
        stages: state.stages.map((s) =>
          s.id === action.stageId ? { ...s, scanPath: action.scanPath } : s,
        ),
      };
    case 'setDatabase':
      return { ...state, databaseId: action.databaseId };
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
