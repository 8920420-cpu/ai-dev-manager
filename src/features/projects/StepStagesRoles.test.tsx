import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToastProvider } from '../../components/ui';
import { StepStagesRoles } from './StepStagesRoles';
import type { StageSaveErrorItem } from '../../api/projectsApi';
import type { Role, Stage } from '../../types/project';

const ROLES: Role[] = [
  { id: 'r-scan', name: 'Scanner', code: 'SCANNER' },
  { id: 'r-prog', name: 'Programmer', code: 'PROGRAMMER' },
];

const STAGES: Stage[] = [
  { id: 's1', name: 'Разработка', roleIds: ['r-prog'], enabled: true },
];

function renderStep(saveErrors?: StageSaveErrorItem[]) {
  render(
    <ToastProvider>
      <StepStagesRoles
        stages={STAGES}
        roles={ROLES}
        stageErrors={{}}
        scanErrors={{}}
        statusErrors={{}}
        saveErrors={saveErrors}
        generalError={null}
        onAddStage={vi.fn()}
        onRemoveStage={vi.fn()}
        onRenameStage={vi.fn()}
        onReorderStage={vi.fn()}
        onSetStageRole={vi.fn()}
        onSetStageEnabled={vi.fn()}
        onSetStageScanPath={vi.fn()}
        onSetStageStatus={vi.fn()}
        onApplyDefaults={vi.fn()}
      />
    </ToastProvider>,
  );
}

describe('StepStagesRoles — серверные ошибки сохранения', () => {
  it('без ошибок блок ошибок не показывается', () => {
    renderStep();
    expect(screen.queryByText(/Контракты данных ролей несогласованы/i)).not.toBeInTheDocument();
  });

  it('показывает несогласованность контрактов полей (roleCode/field/message)', () => {
    renderStep([
      {
        roleCode: 'PROGRAMMER',
        field: 'design_doc',
        code: 'field_not_produced_upstream',
        message: 'Поле не производится более ранней ролью маршрута.',
      },
    ]);
    expect(screen.getByText(/Контракты данных ролей несогласованы/i)).toBeInTheDocument();
    expect(
      screen.getByText(/PROGRAMMER · design_doc: Поле не производится более ранней ролью/i),
    ).toBeInTheDocument();
  });

  it('показывает ошибку валидации этапа с названием этапа', () => {
    renderStep([
      {
        stageId: 's1',
        code: 'stage_task_status_required',
        message: 'Для включённого этапа укажите статус задач (task_status).',
      },
    ]);
    expect(screen.getByText(/Ошибки сохранения этапов/i)).toBeInTheDocument();
    expect(screen.getByText(/Этап «Разработка»:/i)).toBeInTheDocument();
  });
});
