import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { SchemeFlowchart } from './SchemeFlowchart';
import { ToastProvider } from '../../components/ui';
import type { Role, SchemeEdge, Stage } from '../../types/project';

// Роли-пресеты, участвующие в проверке ветвления исходов Task Reviewer.
const PROG_ROLE: Role = { id: 'r-prog', name: 'Programmer', code: 'PROGRAMMER' };
const REVIEWER_ROLE: Role = { id: 'r-rev', name: 'Task Reviewer', code: 'TASK_REVIEWER' };
const PIPELINE_ROLE: Role = { id: 'r-pipe', name: 'Pipeline Service', code: 'PIPELINE_SERVICE' };
const ROLES = [PROG_ROLE, REVIEWER_ROLE, PIPELINE_ROLE];

function stage(id: string, roleId: string, extra: Partial<Stage> = {}): Stage {
  return { id, name: id, roleIds: [roleId], enabled: true, ...extra };
}

function renderFlow(stages: Stage[], edges?: SchemeEdge[]) {
  const ui: ReactElement = (
    <SchemeFlowchart
      stages={stages}
      edges={edges}
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
      onSetStageJoinKey={vi.fn()}
      onApplyDefaults={vi.fn()}
    />
  );
  // ToastProvider — StageSettingsModal внутри использует useToast (выбор папки).
  return render(<ToastProvider>{ui}</ToastProvider>);
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
});

describe('SchemeFlowchart — компактные пиктограммы fork/join', () => {
  it('fork и join рисуются пиктограммами (иконка + подпись), а не карточками этапов', () => {
    renderFlow([
      stage('s-fork', '', { kind: 'fork', stageKey: 'F' }),
      stage('s-join', '', { kind: 'join', stageKey: 'J' }),
    ]);

    // Пиктограмма — кнопка, открывающая настройки узла; краткая подпись рядом.
    const forkBtn = screen.getByRole('button', { name: /Настройки узла «s-fork»/i });
    const joinBtn = screen.getByRole('button', { name: /Настройки узла «s-join»/i });
    expect(within(forkBtn).getByText('Разделить')).toBeInTheDocument();
    expect(within(joinBtn).getByText('Объединить')).toBeInTheDocument();

    // Иконки пиктограмм: GitFork для fork, GitMerge для join (цветовая кодировка
    // success/info задаётся классами пиктограммы в CSS-модуле).
    expect(forkBtn.querySelector('.lucide-git-fork')).not.toBeNull();
    expect(joinBtn.querySelector('.lucide-git-merge')).not.toBeNull();

    // Это не полноразмерная карточка: у пиктограммы нет кнопки «Задачи» и «ручки»
    // перетаскивания (drag/чекбокс перенесены в модал настроек).
    expect(within(forkBtn).queryByText(/Задачи/i)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Перетащите, чтобы изменить порядок/i }),
    ).not.toBeInTheDocument();
  });

  it('клик по пиктограмме открывает настройки узла (StageSettingsModal)', () => {
    renderFlow([stage('s-fork', '', { kind: 'fork', stageKey: 'F' })]);
    // До клика модалка настроек узла не отрисована.
    expect(screen.queryByText(/Настройки узла ·/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Настройки узла «s-fork»/i }));

    // После клика открылась модалка настроек именно этого узла.
    expect(screen.getByText(/Настройки узла · s-fork/i)).toBeInTheDocument();
  });

  it('в участке fork → ветка → join управляющие узлы — пиктограммы, а ветка — карточка', () => {
    const stages: Stage[] = [
      stage('s-fork', '', { kind: 'fork', stageKey: 'F', joinKey: 'J' }),
      stage('s-mid', PROG_ROLE.id, { stageKey: 'M' }),
      stage('s-join', '', { kind: 'join', stageKey: 'J' }),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'F', toKey: 'M', position: 0 },
      { fromKey: 'M', toKey: 'J', position: 1 },
    ];
    renderFlow(stages, edges);

    // fork и join остаются компактными пиктограммами (кнопки настроек узла).
    expect(
      screen.getByRole('button', { name: /Настройки узла «s-fork»/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Настройки узла «s-join»/i }),
    ).toBeInTheDocument();

    // Узел ветки — обычная карточка этапа: у него есть кнопка «Задачи» и роль.
    const midGear = screen.getByRole('button', { name: /Настройки этапа «s-mid»/i });
    const midCard = midGear.closest('li') as HTMLElement;
    expect(within(midCard).getByText(/Задачи/i)).toBeInTheDocument();
    expect(within(midCard).getByText('Programmer')).toBeInTheDocument();
  });
});
