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
  it('выносит исходы Task Reviewer ЗА карточку: успех → Pipeline Service, ошибка → Programmer', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id), stage('s-rev', REVIEWER_ROLE.id)]);

    // Список исходов существует, оба исхода с целями остаются текстом (доступность).
    const outcomes = screen.getByRole('list', { name: /Исходы проверки Task Reviewer/i });
    expect(within(outcomes).getByText(/Успех/i)).toBeInTheDocument();
    expect(within(outcomes).getByText(/Pipeline Service/i)).toBeInTheDocument();
    expect(within(outcomes).getByText(/Ошибка/i)).toBeInTheDocument();
    expect(within(outcomes).getByText(/Programmer/i)).toBeInTheDocument();

    // Список вынесен ЗА карточку Task Reviewer: он не вложен в неё, а стоит рядом
    // (сиблинг) внутри того же узла потока. Карточку находим по её кнопке настроек.
    const gear = screen.getByRole('button', { name: /Настройки этапа «s-rev»/i });
    const nodeWrap = gear.closest('li') as HTMLElement;
    let card = gear as HTMLElement;
    while (card.parentElement && card.parentElement !== nodeWrap) {
      card = card.parentElement;
    }
    expect(card).not.toContainElement(outcomes);
    expect(outcomes.parentElement).toBe(nodeWrap);
  });

  it('для не-Task Reviewer этапов блок ветвления исходов не рендерится', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id), stage('s-pipe', PIPELINE_ROLE.id)]);
    expect(
      screen.queryByRole('list', { name: /Исходы проверки Task Reviewer/i }),
    ).not.toBeInTheDocument();
  });
});

describe('SchemeFlowchart — терминальный узел «Выполнено»', () => {
  it('в конце схемы отрисован декоративный узел «Выполнено» (симметричный «Старту»)', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id)]);
    expect(screen.getByText('Старт')).toBeInTheDocument();
    expect(screen.getByText('Выполнено')).toBeInTheDocument();
  });

  it('узел «Выполнено» декоративный (aria-hidden) и не является кнопкой', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id)]);
    const finish = screen.getByText('Выполнено');
    // Ближайший <li> помечен aria-hidden — узел исключён из дерева доступности.
    expect(finish.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(finish.closest('button')).toBeNull();
    // Кнопка «Добавить этап» сохраняется отдельно.
    expect(
      screen.getByRole('button', { name: /Добавить этап/i }),
    ).toBeInTheDocument();
  });

  it('когда последний этап — Task Reviewer, к узлу «Выполнено» ведёт отдельная стрелка', () => {
    renderFlow([stage('s-prog', PROG_ROLE.id), stage('s-rev', REVIEWER_ROLE.id)]);
    const finishLi = screen.getByText('Выполнено').closest('li') as HTMLElement;
    // У Task Reviewer трейлинг-блок — ветвление исходов, а не стрелка вниз, поэтому
    // перед финальным узлом добавлен отдельный декоративный коннектор со стрелкой.
    const prev = finishLi.previousElementSibling as HTMLElement | null;
    expect(prev).not.toBeNull();
    expect(prev!.getAttribute('aria-hidden')).toBe('true');
    expect(prev!.querySelector('.lucide-arrow-down')).not.toBeNull();
    // Это выделенный li-коннектор, а не карточка (в нём нет кнопок).
    expect(prev!.querySelector('button')).toBeNull();
  });
});
