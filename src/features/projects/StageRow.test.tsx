import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { ToastProvider } from '../../components/ui';
import { StageRow } from './StageRow';
import type { Role, Stage } from '../../types/project';

const SCANNER_ROLE: Role = { id: 'r-scan', name: 'Scanner', code: 'SCANNER' };
const PROG_ROLE: Role = { id: 'r-prog', name: 'Programmer', code: 'PROGRAMMER' };
const ROLES = [SCANNER_ROLE, PROG_ROLE];

function renderRow(stage: Partial<Stage>, props: Partial<Parameters<typeof StageRow>[0]> = {}) {
  const fullStage: Stage = {
    id: 's1',
    name: 'Этап 1',
    roleIds: [],
    enabled: true,
    ...stage,
  };
  const onToggleEnabled = vi.fn();
  const onSetScanPath = vi.fn();
  const onSetStatus = vi.fn();
  const ui: ReactElement = (
    <ToastProvider>
      <ul>
        <StageRow
          stage={fullStage}
          index={0}
          roles={ROLES}
          error={null}
          scanError={null}
          statusError={null}
          statusOptions={['BACKLOG', 'READY', 'CODING', 'REVIEW']}
          canRemove
          dropTarget={false}
          dragging={false}
          onRename={vi.fn()}
          onSetRole={vi.fn()}
          onToggleEnabled={onToggleEnabled}
          onSetScanPath={onSetScanPath}
          onSetStatus={onSetStatus}
          onRemove={vi.fn()}
          onDragStart={vi.fn()}
          onDragEnter={vi.fn()}
          onDrop={vi.fn()}
          onDragEnd={vi.fn()}
          {...props}
        />
      </ul>
    </ToastProvider>
  );
  return { ...render(ui), onToggleEnabled, onSetScanPath, onSetStatus };
}

describe('StageRow P0.1', () => {
  it('чекбокс «Включён» присутствует и для активного этапа отмечен', () => {
    renderRow({ enabled: true, name: 'Разработка' });
    const checkbox = screen.getByRole('checkbox', { name: /Включить этап «Разработка»/i });
    expect(checkbox).toBeChecked();
  });

  it('снятие чекбокса «Включён» вызывает onToggleEnabled(false)', async () => {
    const user = userEvent.setup();
    const { onToggleEnabled } = renderRow({ enabled: true });
    await user.click(screen.getByRole('checkbox'));
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it('отключённый этап показывает текстовый статус «Отключён» и снятый чекбокс', () => {
    renderRow({ enabled: false });
    expect(screen.getByText(/Отключён/i)).toBeInTheDocument();
    expect(screen.getByText(/роль не вызывается/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).not.toBeChecked();
  });

  it('поле папки Scanner показывается для роли с кодом SCANNER', () => {
    renderRow({ roleIds: [SCANNER_ROLE.id] });
    expect(screen.getByLabelText(/Отслеживаемая папка сканера/i)).toBeInTheDocument();
  });

  it('поле папки Scanner НЕ показывается для не-Scanner роли', () => {
    renderRow({ roleIds: [PROG_ROLE.id] });
    expect(screen.queryByLabelText(/Отслеживаемая папка сканера/i)).not.toBeInTheDocument();
  });

  it('ошибка папки Scanner отображается рядом с полем', () => {
    renderRow(
      { roleIds: [SCANNER_ROLE.id] },
      { scanError: 'Укажите папку для отслеживания (обязательно для Scanner).' },
    );
    expect(
      screen.getByText(/Укажите папку для отслеживания/i),
    ).toBeInTheDocument();
  });

  it('дропдаун статуса задач показывается для роли SCANNER', () => {
    renderRow({ roleIds: [SCANNER_ROLE.id] });
    expect(screen.getByLabelText(/Статус задач сканера/i)).toBeInTheDocument();
  });

  it('дропдаун статуса НЕ показывается для не-Scanner роли', () => {
    renderRow({ roleIds: [PROG_ROLE.id] });
    expect(screen.queryByLabelText(/Статус задач сканера/i)).not.toBeInTheDocument();
  });

  it('дропдаун статуса содержит только переданные доступные статусы (занятые исключены)', () => {
    renderRow(
      { roleIds: [SCANNER_ROLE.id] },
      { statusOptions: ['READY', 'CODING'] },
    );
    const select = screen.getByLabelText(/Статус задач сканера/i) as HTMLSelectElement;
    const values = Array.from(select.options).map((o) => o.value).filter(Boolean);
    expect(values).toEqual(['READY', 'CODING']);
  });

  it('выбор статуса вызывает onSetStatus с кодом', async () => {
    const user = userEvent.setup();
    const { onSetStatus } = renderRow({ roleIds: [SCANNER_ROLE.id] });
    await user.selectOptions(screen.getByLabelText(/Статус задач сканера/i), 'CODING');
    expect(onSetStatus).toHaveBeenCalledWith('CODING');
  });

  it('ошибка статуса Scanner отображается рядом с дропдауном', () => {
    renderRow(
      { roleIds: [SCANNER_ROLE.id] },
      { statusError: 'Этот статус уже используется другим этапом Scanner.' },
    );
    expect(screen.getByText(/уже используется другим этапом Scanner/i)).toBeInTheDocument();
  });

  it('для не-Scanner включённого этапа с ролью показывается общий «Статус задач»', () => {
    renderRow({ roleIds: [PROG_ROLE.id], enabled: true });
    expect(screen.getByLabelText(/^Статус задач:/i)).toBeInTheDocument();
    // У Scanner — отдельная подпись, её здесь быть не должно.
    expect(screen.queryByLabelText(/Статус задач сканера/i)).not.toBeInTheDocument();
  });

  it('общий «Статус задач» НЕ показывается для этапа без роли', () => {
    renderRow({ roleIds: [], enabled: true });
    expect(screen.queryByLabelText(/^Статус задач:/i)).not.toBeInTheDocument();
  });

  it('общий «Статус задач» НЕ показывается для пропущенного этапа', () => {
    renderRow({ roleIds: [PROG_ROLE.id], enabled: false });
    expect(screen.queryByLabelText(/^Статус задач:/i)).not.toBeInTheDocument();
  });

  it('выбор общего статуса задач вызывает onSetStatus с кодом', async () => {
    const user = userEvent.setup();
    const { onSetStatus } = renderRow({ roleIds: [PROG_ROLE.id], enabled: true });
    await user.selectOptions(screen.getByLabelText(/^Статус задач:/i), 'CODING');
    expect(onSetStatus).toHaveBeenCalledWith('CODING');
  });
});
