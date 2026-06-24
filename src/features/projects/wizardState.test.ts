import { describe, it, expect } from 'vitest';
import {
  buildPresetState,
  buildStateFromProject,
  wizardReducer,
  type WizardState,
} from './wizardState';
import { SCANNER_ROLE_CODE } from '../../data/presets';
import type { Project, Stage } from '../../types/project';

function findStageByName(state: WizardState, name: string): Stage {
  const s = state.stages.find((st) => st.name === name);
  if (!s) throw new Error(`нет этапа ${name}`);
  return s;
}

describe('wizardReducer / пресеты P0.1', () => {
  it('пресетные этапы по умолчанию включены, роли получают канонический код', () => {
    const state = buildPresetState();
    expect(state.stages.length).toBeGreaterThan(0);
    expect(state.stages.every((s) => s.enabled === true)).toBe(true);

    const scannerRole = state.roles.find((r) => r.code === SCANNER_ROLE_CODE);
    expect(scannerRole).toBeDefined();
    expect(scannerRole?.name).toBe('Scanner');
  });

  it('addStage создаёт включённый этап', () => {
    const state = buildPresetState();
    const next = wizardReducer(state, { type: 'addStage' });
    const added = next.stages[next.stages.length - 1]!;
    expect(added.enabled).toBe(true);
    expect(added.roleIds).toEqual([]);
  });

  it('setStageEnabled переключает флаг, не трогая остальные настройки', () => {
    const state = buildPresetState();
    const scanner = findStageByName(state, 'Programmer');
    // зададим путь, затем отключим
    const withPath = wizardReducer(state, {
      type: 'setStageScanPath',
      stageId: scanner.id,
      scanPath: 'C:\\watch',
    });
    const disabled = wizardReducer(withPath, {
      type: 'setStageEnabled',
      stageId: scanner.id,
      enabled: false,
    });
    const s1 = disabled.stages.find((s) => s.id === scanner.id)!;
    expect(s1.enabled).toBe(false);
    // путь и роль сохранены при отключении
    expect(s1.scanPath).toBe('C:\\watch');
    expect(s1.roleIds).toEqual(scanner.roleIds);

    // повторное включение возвращает путь
    const enabled = wizardReducer(disabled, {
      type: 'setStageEnabled',
      stageId: scanner.id,
      enabled: true,
    });
    const s2 = enabled.stages.find((s) => s.id === scanner.id)!;
    expect(s2.enabled).toBe(true);
    expect(s2.scanPath).toBe('C:\\watch');
  });

  it('смена роли не очищает scanPath', () => {
    const state = buildPresetState();
    const scanner = findStageByName(state, 'Architect');
    const withPath = wizardReducer(state, {
      type: 'setStageScanPath',
      stageId: scanner.id,
      scanPath: '/var/watch',
    });
    const otherRole = state.roles.find((r) => r.code === 'PROGRAMMER')!;
    const changed = wizardReducer(withPath, {
      type: 'setStageRole',
      stageId: scanner.id,
      roleId: otherRole.id,
    });
    const s = changed.stages.find((st) => st.id === scanner.id)!;
    expect(s.roleIds).toEqual([otherRole.id]);
    // настройка Scanner остаётся в модели (скрыта в UI, но не потеряна)
    expect(s.scanPath).toBe('/var/watch');
  });

  it('reorder сохраняет enabled и scanPath этапов', () => {
    const base = buildPresetState();
    const scanner = findStageByName(base, 'Programmer');
    const prepared = wizardReducer(
      wizardReducer(base, { type: 'setStageScanPath', stageId: scanner.id, scanPath: '/w' }),
      { type: 'setStageEnabled', stageId: scanner.id, enabled: false },
    );
    const fromIdx = prepared.stages.findIndex((s) => s.id === scanner.id);
    const reordered = wizardReducer(prepared, { type: 'reorderStage', from: fromIdx, to: 0 });
    const moved = reordered.stages[0]!;
    expect(moved.id).toBe(scanner.id);
    expect(moved.enabled).toBe(false);
    expect(moved.scanPath).toBe('/w');
  });

  it('buildStateFromProject: старые данные без enabled читаются как включённые и код роли бэкафиллится', () => {
    const legacy: Project = {
      id: 'p1',
      name: 'Legacy',
      path: '/p',
      status: 'active',
      pauseReason: null,
      roles: [
        // роль без кода, но с пресетным именем
        { id: 'r1', name: 'Scanner' } as never,
        { id: 'r2', name: 'Programmer' } as never,
      ],
      stages: [
        // этап без поля enabled (старые данные)
        { id: 's1', name: 'Scanner', roleIds: ['r1'], scanPath: '/old' } as never,
        { id: 's2', name: 'Programmer', roleIds: ['r2'] } as never,
      ],
      updatedAt: '2025-01-01T00:00:00.000Z',
      createdAt: '2025-01-01T00:00:00.000Z',
    };
    const state = buildStateFromProject(legacy);
    expect(state.stages.every((s) => s.enabled === true)).toBe(true);
    expect(state.roles.find((r) => r.id === 'r1')?.code).toBe(SCANNER_ROLE_CODE);
    expect(state.stages.find((s) => s.id === 's1')?.scanPath).toBe('/old');
  });
});
