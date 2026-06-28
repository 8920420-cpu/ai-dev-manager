import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { RoleCardModal } from './RoleCardModal';
import type { RoleCard, RoleGroup } from '../../types/settings';

const update = vi.fn();
const listSkills = vi.fn();
vi.mock('../../api/rolesApi', () => ({
  rolesApi: {
    update: (...a: unknown[]) => update(...a),
    listSkills: (...a: unknown[]) => listSkills(...a),
  },
}));

const saveCapabilities = vi.fn();
const saveRoleTools = vi.fn();
vi.mock('../../api/toolsApi', () => ({
  toolsApi: {
    list: () => Promise.resolve([]),
    getCapabilities: () => Promise.resolve([]),
    getRoleTools: () => Promise.resolve([]),
    saveCapabilities: (...a: unknown[]) => saveCapabilities(...a),
    saveRoleTools: (...a: unknown[]) => saveRoleTools(...a),
  },
}));

const intgList = vi.fn();
vi.mock('../../api/integrationsApi', () => ({
  integrationsApi: {
    list: (...a: unknown[]) => intgList(...a),
  },
}));

const rcList = vi.fn();
const rcSaveAll = vi.fn();
vi.mock('../../api/roleConnectionsApi', () => ({
  roleConnectionsApi: {
    list: (...a: unknown[]) => rcList(...a),
    saveAll: (...a: unknown[]) => rcSaveAll(...a),
    make: (role = '', integrationId = '') => ({ id: 'rc1', role, integrationId }),
  },
}));

const GROUPS: RoleGroup[] = [
  { id: 'g1', name: 'Разработка', sortOrder: 10 },
  { id: 'g2', name: 'Контроль качества', sortOrder: 20 },
];

const ROLE: RoleCard = {
  code: 'PROGRAMMER',
  name: 'Programmer',
  description: 'Пишет код',
  prompt: '',
  groupId: 'g1',
  skills: ['b.md'],
};

function renderModal(role: RoleCard = ROLE, onClose = vi.fn(), onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <RoleCardModal open role={role} groups={GROUPS} onClose={onClose} onSaved={onSaved} />
    </ToastProvider>,
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  update.mockReset();
  listSkills.mockReset();
  saveCapabilities.mockReset();
  saveCapabilities.mockResolvedValue([]);
  saveRoleTools.mockReset();
  saveRoleTools.mockResolvedValue([]);
  intgList.mockReset();
  // INTEGRATION-ENGINE-UNIFY-001: «Движок» = список ВКЛЮЧЁННЫХ интеграций
  // (API-коннекторы DeepSeek/OpenAI + хостовые драйверы Codex/Claude Code).
  intgList.mockResolvedValue([
    { id: 'int1', name: 'DeepSeek API', provider: 'deepseek', isEnabled: true, status: 'success' },
    { id: 'int2', name: 'OpenAI API', provider: 'openai', isEnabled: true },
    { id: 'int3', name: 'Codex (драйвер)', provider: 'codex', isEnabled: true },
    { id: 'int4', name: 'Старый коннектор', provider: 'openai', isEnabled: false },
  ]);
  rcList.mockReset();
  rcList.mockResolvedValue([]);
  rcSaveAll.mockReset();
  rcSaveAll.mockResolvedValue([]);
  listSkills.mockResolvedValue([
    { id: 'a.md', name: 'a.md' },
    { id: 'b.md', name: 'b.md' },
    { id: 'group/c.md', name: 'c.md' },
  ]);
});

describe('RoleCardModal — карточка роли', () => {
  it('показывает описание, код роли и подключённые skills', async () => {
    renderModal();
    expect(screen.getByDisplayValue('Пишет код')).toBeInTheDocument();
    expect(screen.getByText(/Канонический код: PROGRAMMER/i)).toBeInTheDocument();
    // Подключённый skill отображается в списке.
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Отключить skill «b.md»/i })).toBeInTheDocument();
  });

  it('селектор группы показывает текущую группу роли', async () => {
    renderModal();
    const groupSelect = screen.getByLabelText(/Смысловая группа/i) as HTMLSelectElement;
    expect(groupSelect.value).toBe('g1');
  });

  it('добавляет skill из серверного списка и не допускает дубли в выборе', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());

    const select = screen.getByLabelText(/Доступные skills/i);
    // Уже подключённый b.md не должен предлагаться к добавлению.
    expect(select).not.toHaveTextContent('(b.md)');

    await user.selectOptions(select, 'a.md');
    await user.click(screen.getByRole('button', { name: /^Добавить$/i }));

    expect(screen.getByRole('button', { name: /Отключить skill «a.md»/i })).toBeInTheDocument();
  });

  it('удаление привязки убирает skill из списка карточки', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Отключить skill «b.md»/i }));
    expect(screen.queryByRole('button', { name: /Отключить skill «b.md»/i })).not.toBeInTheDocument();
  });

  it('сохранение отправляет patch с description/prompt/groupId/skills', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue({ ...ROLE, groupId: 'g2' });
    const { onSaved } = renderModal();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Смысловая группа/i), 'g2');
    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const [code, patch] = update.mock.calls[0]!;
    expect(code).toBe('PROGRAMMER');
    expect(patch).toMatchObject({ groupId: 'g2', skills: ['b.md'], prompt: '' });
    expect(onSaved).toHaveBeenCalled();
  });

  it('подставляет текущий движок (интеграцию) роли', async () => {
    rcList.mockResolvedValue([{ id: 'rc-x', role: 'PROGRAMMER', integrationId: 'int2' }]);
    renderModal();
    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int2'));
  });

  it('поле движка показывается для любой роли (единое поле вместо двух)', async () => {
    renderModal();
    expect(await screen.findByLabelText(/Движок \(исполнитель роли\)/i)).toBeInTheDocument();
    // Бывшего отдельного поля «Интеграция (коннектор)» больше нет.
    expect(screen.queryByLabelText(/Интеграция \(коннектор\)/i)).not.toBeInTheDocument();
  });

  it('в списке движков только включённые интеграции (выключенные скрыты)', async () => {
    renderModal();
    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(intgList).toHaveBeenCalled());
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['— не назначено —', 'DeepSeek API', 'OpenAI API', 'Codex (драйвер)']),
    );
    // Выключенная интеграция (int4) не предлагается.
    expect(labels.some((l) => l?.includes('Старый коннектор'))).toBe(false);
  });

  it('назначает движок роли (интеграцию) и сохраняет через role-connectors', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ROLE);
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Движок \(исполнитель роли\)/i), 'int1');
    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(rcSaveAll).toHaveBeenCalled());
    const [items] = rcSaveAll.mock.calls[0]!;
    expect(items).toEqual([{ id: 'rc1', role: 'PROGRAMMER', integrationId: 'int1' }]);
  });

  it('выбор драйвера показывает подсказку про хостовый драйвер', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Движок \(исполнитель роли\)/i), 'int3');
    // Точное совпадение заголовка Callout (в helper селекта есть похожий текст).
    expect(await screen.findByText('Хостовый драйвер')).toBeInTheDocument();
    expect(screen.getByText(/Роль исполняет драйвер Codex/i)).toBeInTheDocument();
  });

  it('не дёргает role-connectors, если движок не менялся', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ROLE);
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(rcSaveAll).not.toHaveBeenCalled();
  });

  it('не закрывается по Escape (правило проекта)', async () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
