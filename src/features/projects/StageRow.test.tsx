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
  const ui: ReactElement = (
    <ToastProvider>
      <ul>
        <StageRow
          stage={fullStage}
          index={0}
          roles={ROLES}
          error={null}
          scanError={null}
          canRemove
          dropTarget={false}
          dragging={false}
          onRename={vi.fn()}
          onSetRole={vi.fn()}
          onToggleEnabled={onToggleEnabled}
          onSetScanPath={onSetScanPath}
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
  return { ...render(ui), onToggleEnabled, onSetScanPath };
}

describe('StageRow P0.1', () => {
  it('чекбокс «Включён» присутствует и по умолчанию отмечен', () => {
    renderRow({ enabled: true, name: 'Разработка' });
    const checkbox = screen.getByRole('checkbox', { name: /Этап «Разработка» включён/i });
    expect(checkbox).toBeChecked();
  });

  it('снятие чекбокса вызывает onToggleEnabled(false)', async () => {
    const user = userEvent.setup();
    const { onToggleEnabled } = renderRow({ enabled: true });
    await user.click(screen.getByRole('checkbox'));
    expect(onToggleEnabled).toHaveBeenCalledWith(false);
  });

  it('отключённый этап показывает текстовый статус «Отключён»', () => {
    renderRow({ enabled: false });
    expect(screen.getByText(/Отключён/i)).toBeInTheDocument();
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
});
