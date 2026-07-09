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

// Программист — НЕ рассуждающая роль (ROLE-EXEC-TYPE-001): отдельный конвейер
// Claude Code, без матрицы reasoning-движков.
const ROLE: RoleCard = {
  code: 'PROGRAMMER',
  name: 'Programmer',
  description: 'Пишет код',
  prompt: '',
  groupId: 'g1',
  skills: ['b.md'],
};

// Рассуждающая роль — у неё есть выбор «Движок (исполнитель роли)».
const ARCHITECT_ROLE: RoleCard = {
  code: 'ARCHITECT',
  name: 'Architect',
  description: 'Проектирует решение',
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

  // --- ROLE-EXEC-TYPE-001: «Движок» только у рассуждающих ролей ---

  it('ARCHITECT (reasoning) → показывает Select «Движок (исполнитель роли)»', async () => {
    renderModal(ARCHITECT_ROLE);
    expect(await screen.findByLabelText(/Движок \(исполнитель роли\)/i)).toBeInTheDocument();
    // Бывшего отдельного поля «Интеграция (коннектор)» больше нет.
    expect(screen.queryByLabelText(/Интеграция \(коннектор\)/i)).not.toBeInTheDocument();
  });

  it('подставляет текущий движок (интеграцию) рассуждающей роли', async () => {
    rcList.mockResolvedValue([{ id: 'rc-x', role: 'ARCHITECT', integrationId: 'int2' }]);
    renderModal(ARCHITECT_ROLE);
    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int2'));
  });

  it('в списке движков только включённые интеграции (выключенные скрыты)', async () => {
    renderModal(ARCHITECT_ROLE);
    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(intgList).toHaveBeenCalled());
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toEqual(
      expect.arrayContaining(['— не назначено —', 'DeepSeek API', 'OpenAI API', 'Codex (драйвер)']),
    );
    // Выключенная интеграция (int4) не предлагается.
    expect(labels.some((l) => l?.includes('Старый коннектор'))).toBe(false);
  });

  it('назначает движок рассуждающей роли и сохраняет через role-connectors', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ARCHITECT_ROLE);
    renderModal(ARCHITECT_ROLE);
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Движок \(исполнитель роли\)/i), 'int1');
    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(rcSaveAll).toHaveBeenCalled());
    const [items] = rcSaveAll.mock.calls[0]!;
    expect(items).toEqual([{ id: 'rc1', role: 'ARCHITECT', integrationId: 'int1' }]);
  });

  it('выбор драйвера показывает подсказку про хостовый драйвер', async () => {
    const user = userEvent.setup();
    renderModal(ARCHITECT_ROLE);
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.selectOptions(screen.getByLabelText(/Движок \(исполнитель роли\)/i), 'int3');
    // Точное совпадение заголовка Callout (в helper селекта есть похожий текст).
    expect(await screen.findByText('Хостовый драйвер')).toBeInTheDocument();
    expect(screen.getByText(/Роль исполняет драйвер Codex/i)).toBeInTheDocument();
  });

  it('не дёргает role-connectors, если движок не менялся', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ARCHITECT_ROLE);
    renderModal(ARCHITECT_ROLE);
    await waitFor(() => expect(intgList).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(rcSaveAll).not.toHaveBeenCalled();
  });

  it('TASK_INTAKE_OFFICER + Codex-интеграция: «Движок» показывает Codex, не DeepSeek', async () => {
    const role: RoleCard = { ...ROLE, code: 'TASK_INTAKE_OFFICER', name: 'Приёмщик задач' };
    // Назначение роли — хостовый драйвер Codex (int3), записанное в role-connectors.
    rcList.mockResolvedValue([{ id: 'rc-codex', role: 'TASK_INTAKE_OFFICER', integrationId: 'int3' }]);
    renderModal(role);

    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int3'));
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toContain('Codex');
    expect(selected.textContent).not.toContain('DeepSeek');
  });

  it('рассуждающая роль с claude_code-интеграцией: «Движок» показывает Claude Code', async () => {
    // Добавляем драйвер Claude Code в список интеграций и назначаем его роли.
    intgList.mockResolvedValue([
      { id: 'int1', name: 'DeepSeek API', provider: 'deepseek', isEnabled: true, status: 'success' },
      { id: 'int5', name: 'Claude Code (драйвер)', provider: 'claude_code', isEnabled: true },
    ]);
    rcList.mockResolvedValue([{ id: 'rc-cc', role: 'ARCHITECT', integrationId: 'int5' }]);
    renderModal(ARCHITECT_ROLE);

    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int5'));
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toContain('Claude Code');
  });

  it('рассуждающая роль с DeepSeek-интеграцией: «Движок» показывает DeepSeek (backward compat)', async () => {
    // Старое назначение через API-коннектор DeepSeek (int1) — должно работать как раньше.
    rcList.mockResolvedValue([{ id: 'rc-ds', role: 'ARCHITECT', integrationId: 'int1' }]);
    renderModal(ARCHITECT_ROLE);

    const select = (await screen.findByLabelText(/Движок \(исполнитель роли\)/i)) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('int1'));
    const selected = select.options[select.selectedIndex];
    expect(selected.textContent).toContain('DeepSeek');
  });

  // --- Не рассуждающие роли: статичная метка вместо Select ---

  it('PIPELINE_SERVICE (host) → нет Select «Движок», метка «исполняется host-runner»', async () => {
    const role: RoleCard = { ...ROLE, code: 'PIPELINE_SERVICE', name: 'Pipeline Service' };
    renderModal(role);
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Движок \(исполнитель роли\)/i)).not.toBeInTheDocument();
    expect(screen.getByText('исполняется host-runner')).toBeInTheDocument();
  });

  it('GIT_INTEGRATOR (host) → нет Select «Движок», метка «исполняется host-runner»', async () => {
    const role: RoleCard = { ...ROLE, code: 'GIT_INTEGRATOR', name: 'Git Integrator' };
    renderModal(role);
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Движок \(исполнитель роли\)/i)).not.toBeInTheDocument();
    expect(screen.getByText('исполняется host-runner')).toBeInTheDocument();
  });

  it('SCANNER (файловый сервис) → нет Select «Движок», метка «файловый сервис»', async () => {
    const role: RoleCard = { ...ROLE, code: 'SCANNER', name: 'Scanner' };
    renderModal(role);
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Движок \(исполнитель роли\)/i)).not.toBeInTheDocument();
    expect(screen.getByText('файловый сервис')).toBeInTheDocument();
  });

  it('PROGRAMMER → нет Select «Движок», метка «Claude Code (отдельный конвейер)»', async () => {
    renderModal();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());
    expect(screen.queryByLabelText(/Движок \(исполнитель роли\)/i)).not.toBeInTheDocument();
    expect(screen.getByText('Claude Code (отдельный конвейер)')).toBeInTheDocument();
  });

  it('сохранение НЕ рассуждающей роли не вызывает role-connectors (бэкенд вернёт 422)', async () => {
    const user = userEvent.setup();
    update.mockResolvedValue(ROLE);
    // Даже если у роли осталось стороннее назначение — фронт его не переписывает.
    rcList.mockResolvedValue([{ id: 'rc-stale', role: 'PROGRAMMER', integrationId: 'int1' }]);
    renderModal();
    await waitFor(() => expect(listSkills).toHaveBeenCalled());

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
