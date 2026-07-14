import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../components/ui';
import { SchemeFlowchart } from './SchemeFlowchart';
import type { Role, SchemeEdge, Stage } from '../../types/project';

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

// STAGE-ROLE-EXECUTOR-001 — регресс: роли без исполнителя фильтруются только из
// выпадающего списка «Ответственная роль», но уже сохранённая роль этапа обязана
// оставаться видимой (и на карточке схемы, и в опциях при редактировании).
describe('SchemeFlowchart — сохранённая роль без исполнителя (STAGE-ROLE-EXECUTOR-001)', () => {
  // TESTER — роль без исполнителя, но уже назначенная сохранённому этапу;
  // REVIEWER — тоже без исполнителя, но НЕ назначена; PROGRAMMER — исполняемая.
  const TESTER_ROLE: Role = { id: 'r-test', name: 'Tester', code: 'TESTER' };
  const REVIEWER_HIDDEN_ROLE: Role = { id: 'r-rev-hidden', name: 'Reviewer', code: 'REVIEWER' };
  const ROLES_WITH_HIDDEN = [PROG_ROLE, TESTER_ROLE, REVIEWER_HIDDEN_ROLE];

  function renderWithHidden(stages: Stage[]) {
    // StageSettingsModal использует useToast → нужен ToastProvider вокруг схемы.
    const ui: ReactElement = (
      <ToastProvider>
        <SchemeFlowchart
          stages={stages}
          roles={ROLES_WITH_HIDDEN}
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
      </ToastProvider>
    );
    return render(ui);
  }

  it('сохранённая роль без исполнителя остаётся видимой на карточке схемы', () => {
    renderWithHidden([stage('s-test', TESTER_ROLE.id, { name: 'Тестирование' })]);
    // Карточка показывает имя роли, а не заглушку «Роль не выбрана».
    expect(screen.getByText('Tester')).toBeInTheDocument();
    expect(screen.queryByText('Роль не выбрана')).not.toBeInTheDocument();
  });

  it('в выборе «Ответственная роль» видна сохранённая роль без исполнителя и скрыты неназначенные', () => {
    renderWithHidden([stage('s-test', TESTER_ROLE.id, { name: 'Тестирование' })]);

    // Открываем модалку настроек этапа по кнопке-шестерёнке.
    fireEvent.click(screen.getByRole('button', { name: /Настройки этапа «Тестирование»/i }));

    const select = screen.getByRole('combobox', { name: /Ответственная роль/i });
    // Сохранённая роль без исполнителя присутствует в опциях и выбрана.
    expect(within(select).getByRole('option', { name: 'Tester' })).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe(TESTER_ROLE.id);
    // Исполняемая роль доступна для выбора.
    expect(within(select).getByRole('option', { name: 'Programmer' })).toBeInTheDocument();
    // Неназначенная роль без исполнителя из выбора исключена.
    expect(within(select).queryByRole('option', { name: 'Reviewer' })).not.toBeInTheDocument();
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

// SCHEME-GRAPH-LAYOUT-001 — graph-mode: маршрут рисуется строго по рёбрам.
describe('SchemeFlowchart — graph-mode (маршрут по рёбрам)', () => {
  const ROUTER_ROLE: Role = { id: 'r-router', name: 'Task Router', code: 'TASK_ROUTER' };
  const MINI_ROLE: Role = { id: 'r-mini', name: 'Mini Architect', code: 'MINI_ARCHITECT' };
  const ARCH_ROLE: Role = { id: 'r-arch', name: 'Architect', code: 'ARCHITECT' };
  const GRAPH_ROLES = [ROUTER_ROLE, MINI_ROLE, ARCH_ROLE, PROG_ROLE, REVIEWER_ROLE, PIPELINE_ROLE];

  function gStage(id: string, roleId: string): Stage {
    return { id, stageKey: id, kind: 'stage', name: id, roleIds: [roleId], enabled: true };
  }

  function renderGraph(stages: Stage[], edges: SchemeEdge[]) {
    const ui: ReactElement = (
      <SchemeFlowchart
        stages={stages}
        edges={edges}
        roles={GRAPH_ROLES}
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

  it('условная развилка: обе ветви и condition-подписи видны, стрелки нарисованы', () => {
    const stages = [
      gStage('router', ROUTER_ROLE.id),
      gStage('mini', MINI_ROLE.id),
      gStage('arch', ARCH_ROLE.id),
      gStage('prog', PROG_ROLE.id),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'router', toKey: 'mini', condition: 'small', position: 0 },
      { fromKey: 'router', toKey: 'arch', condition: null, position: 1 },
      { fromKey: 'mini', toKey: 'prog', position: 0 },
      { fromKey: 'arch', toKey: 'prog', position: 0 },
    ];
    const { container } = renderGraph(stages, edges);

    // Ветвление по условию с двумя колонками и подписями исходов.
    const branchGroup = screen.getByRole('group', { name: 'Ветвление по условию' });
    const columns = Array.from(branchGroup.children) as HTMLElement[];
    expect(columns).toHaveLength(2);
    expect(within(columns[0]!).getByText('small')).toBeInTheDocument();
    expect(within(columns[0]!).getByText('Mini Architect')).toBeInTheDocument();
    expect(within(columns[1]!).getByText('по умолчанию')).toBeInTheDocument();
    expect(within(columns[1]!).getByText('Architect')).toBeInTheDocument();

    // Programmer — узел схождения после развилки; терминал «Выполнено» у конца маршрута.
    expect(screen.getByText('Programmer')).toBeInTheDocument();
    expect(screen.getByText('Выполнено')).toBeInTheDocument();
    // Все стрелки направлены вниз (коннекторы графа).
    expect(container.querySelectorAll('.lucide-arrow-down').length).toBeGreaterThan(0);
  });

  it('ручной Task Reviewer-branch НЕ появляется, если рёбра задают линейный маршрут', () => {
    const stages = [
      gStage('prog', PROG_ROLE.id),
      gStage('rev', REVIEWER_ROLE.id),
      gStage('pipe', PIPELINE_ROLE.id),
    ];
    const edges: SchemeEdge[] = [
      { fromKey: 'prog', toKey: 'rev', position: 0 },
      { fromKey: 'rev', toKey: 'pipe', position: 1 },
    ];
    renderGraph(stages, edges);

    // Хардкод-ветвление исходов Task Reviewer в graph-mode не рисуется — маршрут из рёбер.
    expect(
      screen.queryByRole('list', { name: /Исходы проверки Task Reviewer/i }),
    ).not.toBeInTheDocument();
    // Task Reviewer — обычный узел оси, за ним Pipeline Service.
    expect(screen.getByText('Task Reviewer')).toBeInTheDocument();
    expect(screen.getByText('Pipeline Service')).toBeInTheDocument();
  });

  it('недостижимый узел показан отдельной группой (не теряется)', () => {
    const stages = [
      gStage('a', PROG_ROLE.id),
      gStage('b', REVIEWER_ROLE.id),
      gStage('orphan', PIPELINE_ROLE.id),
    ];
    const edges: SchemeEdge[] = [{ fromKey: 'a', toKey: 'b', position: 0 }];
    renderGraph(stages, edges);

    const detached = screen.getByRole('group', { name: 'Недостижимые узлы' });
    expect(within(detached).getByText('Pipeline Service')).toBeInTheDocument();
  });
});
