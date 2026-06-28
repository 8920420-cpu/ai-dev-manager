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

const asGet = vi.fn();
const asSave = vi.fn();
vi.mock('../../api/appSettingsApi', () => ({
  appSettingsApi: {
    get: (...a: unknown[]) => asGet(...a),
    save: (...a: unknown[]) => asSave(...a),
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
  intgList.mockResolvedValue([
    { id: 'int1', name: 'DeepSeek', status: 'success' },
    { id: 'int2', name: 'OpenAI' },
  ]);
  rcList.mockReset();
  rcList.mockResolvedValue([]);
  rcSaveAll.mockReset();
  rcSaveAll.mockResolvedValue([]);
  asGet.mockReset();
  asGet.mockResolvedValue({
    maxConcurrencyPerRole: 3,
    programmerConcurrency: 3,
    roleEngines: { ARCHITECT: 'codex', DECOMPOSER: 'codex' },
  });
  asSave.mockReset();
  asSave.mockResolvedValue({
    maxConcurrencyPerRole: 3,
    programmerConcurrency: 3,
    roleEngines: { ARCHITECT: 'claude_code', DECOMPOSER: 'codex' },
  });
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

  it('подставляет текущее назначение интеграции роли', async () => {
    rcList.mockResolvedValue([{ id: 'rc-x', role: 'PROGRAMMER', integrationId: 'int2' }]);
    renderModal();
    const select = (await screen.findByLabelText(/Интеграция \(коннектор\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int2'));
  });

  it('назначает интеграцию роли и сохраняет назначение через role-connectors', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ROLE);
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Интеграция \(коннектор\)/i), 'int1');
    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(rcSaveAll).toHaveBeenCalled());
    const [items] = rcSaveAll.mock.calls[0]!;
    expect(items).toEqual([{ id: 'rc1', role: 'PROGRAMMER', integrationId: 'int1' }]);
  });

  it('не дёргает role-connectors, если интеграция не менялась', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ROLE);
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(rcSaveAll).not.toHaveBeenCalled();
  });

  const ARCHITECT: RoleCard = {
    code: 'ARCHITECT',
    name: 'Архитектор',
    description: 'Проектирует',
    prompt: 'p',
    groupId: 'g1',
    skills: [],
  };

  it('для рассуждающей роли показывает движок из app-settings', async () => {
    renderModal(ARCHITECT);
    const sel = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(sel.value).toBe('codex'));
  });

  it('не показывает движок для не-рассуждающей роли (PROGRAMMER)', async () => {
    renderModal();
    await waitFor(() => expect(intgList).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Движок \(исполнитель роли\)/i)).not.toBeInTheDocument();
    expect(asGet).not.toHaveBeenCalled();
  });

  it('сохраняет движок роли полной картой role_engines (прочие роли не затёрты)', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ARCHITECT);
    renderModal(ARCHITECT);
    const sel = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(sel.value).toBe('codex'));

    await user.selectOptions(sel, 'claude_code');
    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(asSave).toHaveBeenCalled());
    const [patch] = asSave.mock.calls[0]!;
    expect(patch).toEqual({ roleEngines: { ARCHITECT: 'claude_code', DECOMPOSER: 'codex' } });
  });

  it('не дёргает app-settings, если движок не менялся', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ARCHITECT);
    renderModal(ARCHITECT);
    await waitFor(() => expect(asGet).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(asSave).not.toHaveBeenCalled();
  });

  it('не закрывается по Escape (правило проекта)', async () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
