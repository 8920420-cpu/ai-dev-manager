/**
 * Репозиторий справочника полей и контрактов ролей (ROLE-FIELD-CONTRACT-001).
 *
 * Поле — единица данных пайплайна; контракт роли описывает её входящие/исходящие
 * поля. Изменение контракта может поставить проекты на паузу для пересогласования
 * (см. RoleContractSaveResult.pausedProjects).
 *
 * Endpoints:
 *   GET    /api/fields              → справочник полей
 *   POST   /api/fields              → создать поле (201)
 *   PUT    /api/fields/:id          → обновить поле
 *   DELETE /api/fields/:id          → удалить поле
 *   GET    /api/roles/:code/fields  → контракт роли (входящие/исходящие)
 *   PUT    /api/roles/:code/fields  → сохранить контракт роли
 */
import { http } from './http';
import type {
  Field,
  FieldInput,
  RoleContract,
  RoleContractInput,
  RoleContractSaveResult,
} from '../types/fields';

export const fieldsApi = {
  /** Справочник всех полей. */
  async listFields(signal?: AbortSignal): Promise<Field[]> {
    const { fields } = await http.get<{ fields: Field[] }>('/api/fields', { signal });
    return fields ?? [];
  },

  /** Создать новое поле справочника (201). */
  async createField(input: FieldInput): Promise<Field> {
    const body: FieldInput = {
      key: input.key.trim(),
      name: input.name.trim(),
    };
    if (input.description !== undefined) body.description = input.description.trim();
    if (input.valueType !== undefined) body.valueType = input.valueType;
    return http.post<Field>('/api/fields', body);
  },

  /** Обновить поле справочника. */
  async updateField(id: string, input: FieldInput): Promise<Field> {
    const body: FieldInput = {
      key: input.key.trim(),
      name: input.name.trim(),
    };
    if (input.description !== undefined) body.description = input.description.trim();
    if (input.valueType !== undefined) body.valueType = input.valueType;
    return http.put<Field>(`/api/fields/${encodeURIComponent(id)}`, body);
  },

  /** Удалить поле справочника. */
  async deleteField(id: string): Promise<void> {
    await http.del(`/api/fields/${encodeURIComponent(id)}`);
  },

  /** Контракт роли: входящие/исходящие поля. */
  async getRoleFields(code: string, signal?: AbortSignal): Promise<RoleContract> {
    return http.get<RoleContract>(`/api/roles/${encodeURIComponent(code)}/fields`, { signal });
  },

  /**
   * Сохранить контракт роли (replace-set входящих/исходящих полей). В ответе —
   * актуальный контракт и список кодов проектов, поставленных на паузу.
   */
  async saveRoleFields(code: string, input: RoleContractInput): Promise<RoleContractSaveResult> {
    return http.put<RoleContractSaveResult>(
      `/api/roles/${encodeURIComponent(code)}/fields`,
      input,
    );
  },
};
