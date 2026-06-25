import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { RoleFieldsModal } from './RoleFieldsModal';
import type { Field, RoleContract, RoleContractSaveResult } from '../../types/fields';

const getRoleFields = vi.fn();
const saveRoleFields = vi.fn();
const listFields = vi.fn();
const createField = vi.fn();
vi.mock('../../api/fieldsApi', () => ({
  fieldsApi: {
    getRoleFields: (...a: unknown[]) => getRoleFields(...a),
    saveRoleFields: (...a: unknown[]) => saveRoleFields(...a),
    listFields: (...a: unknown[]) => listFields(...a),
    createField: (...a: unknown[]) => createField(...a),
  },
}));

const CONTRACT: RoleContract = {
  roleCode: 'PROGRAMMER',
  inputs: [
    {
      id: 'f1',
      key: 'task_id',
      name: 'Идентификатор задачи',
      description: '',
      valueType: 'text',
      required: true,
    },
  ],
  outputs: [],
};

const CATALOG: Field[] = [
  { id: 'f1', key: 'task_id', name: 'Идентификатор задачи', description: '', valueType: 'text' },
  { id: 'f2', key: 'diff', name: 'Дифф изменений', description: 'патч', valueType: 'text' },
];

function renderModal(onClose = vi.fn()) {
  render(
    <ToastProvider>
      <RoleFieldsModal open roleCode="PROGRAMMER" roleName="Programmer" onClose={onClose} />
    </ToastProvider>,
  );
  return { onClose };
}

beforeEach(() => {
  getRoleFields.mockReset();
  saveRoleFields.mockReset();
  listFields.mockReset();
  createField.mockReset();
  getRoleFields.mockResolvedValue(CONTRACT);
  listFields.mockResolvedValue(CATALOG);
});

describe('RoleFieldsModal — контракт данных роли', () => {
  it('рендерит две колонки и загруженные входящие поля', async () => {
    renderModal();
    await waitFor(() => expect(getRoleFields).toHaveBeenCalledWith('PROGRAMMER', expect.anything()));
    expect(screen.getByText('Входящие данные')).toBeInTheDocument();
    expect(screen.getByText('Исходящие данные')).toBeInTheDocument();
    expect(screen.getByText('Идентификатор задачи')).toBeInTheDocument();
  });

  it('добавление поля из справочника попадает в нужную колонку (Исходящие)', async () => {
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(getRoleFields).toHaveBeenCalled());

    // Кнопка «Добавить» в колонке «Исходящие данные».
    const outputsSection = screen.getByRole('region', { name: 'Исходящие данные' });
    await user.click(outputsSection.querySelector('button')!);

    // Открылся пикер — выбираем поле «Дифф изменений».
    await waitFor(() => expect(listFields).toHaveBeenCalled());
    await user.click(screen.getByRole('button', { name: /Добавить поле «Дифф изменений»/i }));

    // Поле появилось именно в колонке «Исходящие».
    const outputs = screen.getByRole('region', { name: 'Исходящие данные' });
    expect(outputs).toHaveTextContent('Дифф изменений');
    // А во «Входящих» его нет.
    const inputs = screen.getByRole('region', { name: 'Входящие данные' });
    expect(inputs).not.toHaveTextContent('Дифф изменений');
  });

  it('показывает поставленные на паузу проекты после сохранения', async () => {
    const user = userEvent.setup();
    const result: RoleContractSaveResult = {
      roleCode: 'PROGRAMMER',
      inputs: CONTRACT.inputs,
      outputs: [],
      changed: true,
      pausedProjects: ['alpha', 'beta'],
    };
    saveRoleFields.mockResolvedValue(result);
    const { onClose } = renderModal();
    await waitFor(() => expect(getRoleFields).toHaveBeenCalled());

    await user.click(screen.getByRole('button', { name: /^Сохранить$/i }));

    await waitFor(() => expect(saveRoleFields).toHaveBeenCalled());
    expect(
      await screen.findByText(/поставлены на паузу для пересогласования/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/alpha, beta/)).toBeInTheDocument();
    // Модалка не закрывается, пока пользователь не увидит проекты.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('не закрывается по Escape (правило проекта)', async () => {
    const { onClose } = renderModal();
    await waitFor(() => expect(getRoleFields).toHaveBeenCalled());
    fireEvent.keyDown(screen.getAllByRole('dialog')[0]!, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
