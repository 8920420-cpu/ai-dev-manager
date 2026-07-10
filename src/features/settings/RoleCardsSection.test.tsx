import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { RoleCardsSection } from './RoleCardsSection';
import type { RoleCard, RoleGroup } from '../../types/settings';

const list = vi.fn();
const update = vi.fn();
const listSkills = vi.fn();
vi.mock('../../api/rolesApi', () => ({
  rolesApi: {
    list: (...a: unknown[]) => list(...a),
    update: (...a: unknown[]) => update(...a),
    listSkills: (...a: unknown[]) => listSkills(...a),
  },
}));

const groupsList = vi.fn();
const groupsCreate = vi.fn();
const groupsUpdate = vi.fn();
const groupsRemove = vi.fn();
vi.mock('../../api/roleGroupsApi', () => ({
  roleGroupsApi: {
    list: (...a: unknown[]) => groupsList(...a),
    create: (...a: unknown[]) => groupsCreate(...a),
    update: (...a: unknown[]) => groupsUpdate(...a),
    remove: (...a: unknown[]) => groupsRemove(...a),
  },
}));

const GROUPS: RoleGroup[] = [{ id: 'g1', name: 'Разработка', sortOrder: 10 }];

const ROLES: RoleCard[] = [
  { code: 'ARCHITECT', name: 'Architect', description: 'Проектирует', prompt: '', groupId: 'g1', skills: [] },
  { code: 'PROGRAMMER', name: 'Programmer', description: '', prompt: '', groupId: null, skills: ['a.md'] },
];

function renderSection() {
  render(
    <ToastProvider>
      <RoleCardsSection />
    </ToastProvider>,
  );
}

beforeEach(() => {
  list.mockReset();
  update.mockReset();
  listSkills.mockReset();
  groupsList.mockReset();
  groupsCreate.mockReset();
  groupsUpdate.mockReset();
  groupsRemove.mockReset();
  list.mockResolvedValue(ROLES);
  listSkills.mockResolvedValue([]);
  groupsList.mockResolvedValue(GROUPS);
});

describe('RoleCardsSection — дерево ролей по группам', () => {
  it('рендерит роли с описанием и кнопкой открытия', async () => {
    renderSection();
    await waitFor(() => screen.getByRole('button', { name: /Открыть карточку роли «Architect»/i }));
    expect(screen.getByText('Проектирует')).toBeInTheDocument();
    expect(screen.getByText('Описание не задано')).toBeInTheDocument();
  });

  it('показывает заголовок группы и корзину «Прочее» для роли без группы', async () => {
    renderSection();
    await waitFor(() => screen.getByRole('button', { name: /Открыть карточку роли «Architect»/i }));
    expect(screen.getByRole('heading', { name: /Разработка/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Прочее/i })).toBeInTheDocument();
  });

  it('создание группы отправляется на сервер', async () => {
    const user = userEvent.setup();
    groupsCreate.mockResolvedValue({ id: 'g2', name: 'Тестирование', sortOrder: 20 });
    renderSection();
    await waitFor(() => screen.getByRole('button', { name: /Открыть карточку роли «Architect»/i }));

    await user.type(screen.getByLabelText('Название новой группы'), 'Тестирование');
    await user.click(screen.getByRole('button', { name: /Добавить группу/i }));

    await waitFor(() => expect(groupsCreate).toHaveBeenCalledWith('Тестирование'));
  });

  it('клик по строке роли открывает модальное окно карточки', async () => {
    const user = userEvent.setup();
    renderSection();
    await waitFor(() => screen.getByRole('button', { name: /Открыть карточку роли «Programmer»/i }));

    await user.click(screen.getByRole('button', { name: /Открыть карточку роли «Programmer»/i }));

    expect(await screen.findByRole('dialog')).toHaveTextContent(/Роль: Programmer/i);
  });
});
