import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SchemeFlowchart } from './SchemeFlowchart';
import type { Role, Stage } from '../../types/project';

// Роли-пресеты, участвующие в проверке ветвления исходов Task Reviewer.
const PROG_ROLE: Role = { id: 'r-prog', name: 'Programmer', code: 'PROGRAMMER' };
const REVIEWER_ROLE: Role = { id: 'r-rev', name: 'Task Reviewer', code: 'TASK_REVIEWER' };
const PIPELINE_ROLE: Role = { id: 'r-pipe', name: 'Pipeline Service', code: 'PIPELINE_SERVICE' };
const ROLES = [PROG_ROLE, REVIEWER_ROLE, PIPELINE_ROLE];

function stage(id: string, roleId: string, extra: Partial<Stage> = {}): Stage {
  return { id, name: id, roleIds: [roleId], enabled: true, ...extra };
}

function renderFlow(stages: Stage[]) {
  const ui: ReactElement = (
    <SchemeFlowchart
      stages={stages}
      roles={ROLES}
      stageErrors={{}}
      scanErrors={{}}
      statusErrors={{}}
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
  );
  return render(ui);
}

describe('SchemeFlowchart — ветвление исходов Task Reviewer', () => {
  it('на карточке Task Reviewer показывает оба исхода: успех → Pipeline Service, ошибка → Programmer', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id), stage('s-rev', REVIEWER_ROLE.id)]);
    const routes = screen.getByRole('list', { name: /Исходы проверки Task Reviewer/i });
    expect(within(routes).getByText(/Успех/i)).toBeInTheDocument();
    expect(within(routes).getByText(/Pipeline Service/i)).toBeInTheDocument();
    expect(within(routes).getByText(/Ошибка/i)).toBeInTheDocument();
    expect(within(routes).getByText(/Programmer/i)).toBeInTheDocument();
  });

  it('для не-Task Reviewer этапов блок ветвления исходов не рендерится', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id), stage('s-pipe', PIPELINE_ROLE.id)]);
    expect(
      screen.queryByRole('list', { name: /Исходы проверки Task Reviewer/i }),
    ).not.toBeInTheDocument();
  });
});
