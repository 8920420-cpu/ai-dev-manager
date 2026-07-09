import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps, ReactElement } from 'react';
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

function renderFlow(
  stages: Stage[],
  edges?: SchemeEdge[],
  overrides: Partial<ComponentProps<typeof SchemeFlowchart>> = {},
) {
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
      {...overrides}
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

    // Это не полноразмерная карточка: у пиктограммы нет кнопки «Задачи» (задачи —
    // атрибут этапа с ролью). Но порядок узла по-прежнему меняется перетаскиванием:
    // на пиктограмме есть отдельная «ручка» (grip) рядом с кнопкой настроек.
    expect(within(forkBtn).queryByText(/Задачи/i)).not.toBeInTheDocument();
    const forkPictogram = forkBtn.parentElement as HTMLElement;
    expect(
      within(forkPictogram).getByRole('button', {
        name: /Перетащите, чтобы изменить порядок/i,
      }),
    ).toBeInTheDocument();
  });

  it('пиктограмму fork/join можно перетащить за «ручку» — вызывается onReorderStage', () => {
    const onReorderStage = vi.fn();
    renderFlow(
      [
        stage('s-fork', '', { kind: 'fork', stageKey: 'F' }),
        stage('s-join', '', { kind: 'join', stageKey: 'J' }),
      ],
      undefined,
      { onReorderStage },
    );

    const forkPictogram = screen
      .getByRole('button', { name: /Настройки узла «s-fork»/i })
      .parentElement as HTMLElement;
    const joinPictogram = screen
      .getByRole('button', { name: /Настройки узла «s-join»/i })
      .parentElement as HTMLElement;

    // Перетаскивание включается захватом «ручки» (grip) пиктограммы fork, затем
    // fork (index 0) переносится на позицию join (index 1) — как у карточек этапов.
    const grip = within(forkPictogram).getByRole('button', {
      name: /Перетащите, чтобы изменить порядок/i,
    });
    fireEvent.mouseDown(grip);
    fireEvent.dragStart(forkPictogram);
    fireEvent.dragEnter(joinPictogram);
    fireEvent.drop(joinPictogram);

    expect(onReorderStage).toHaveBeenCalledWith(0, 1);
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
