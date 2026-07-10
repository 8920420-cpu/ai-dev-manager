/**
 * Типы справочника полей и контрактов ролей (ROLE-FIELD-CONTRACT-001).
 *
 * Поле (`Field`) — единица данных, которую роли производят (исходящие) или
 * потребляют (входящие). Контракт роли (`RoleContract`) описывает входящие и
 * исходящие поля конкретной роли. Согласованность контрактов проверяется
 * сервером при сохранении этапов проекта (см. fieldsApi и stages).
 */

/** Тип значения поля справочника (зеркало enum value_type на backend). */
export type FieldValueType = 'text' | 'number' | 'boolean' | 'list' | 'json';

/** Машинные коды типов значений в порядке отображения. */
export const FIELD_VALUE_TYPES = ['text', 'number', 'boolean', 'list', 'json'] as const;

/** Человекочитаемые подписи типов значений (RU). */
export const FIELD_VALUE_TYPE_LABEL: Record<FieldValueType, string> = {
  text: 'Текст',
  number: 'Число',
  boolean: 'Да/Нет',
  list: 'Список',
  json: 'JSON',
};

/** Подпись типа значения с запасным вариантом для неизвестных кодов. */
export function fieldValueTypeLabel(valueType: string): string {
  return FIELD_VALUE_TYPE_LABEL[valueType as FieldValueType] ?? valueType;
}

/** Поле справочника (GET /api/fields). */
export interface Field {
  id: string;
  /** Машинный ключ поля (^[A-Za-z][A-Za-z0-9_.-]{0,63}$). */
  key: string;
  /** Отображаемое имя. */
  name: string;
  description: string;
  valueType: FieldValueType;
}

/** Полезная нагрузка создания/обновления поля справочника. */
export interface FieldInput {
  key: string;
  name: string;
  description?: string;
  valueType?: FieldValueType;
}

/**
 * Поле в контракте роли: справочное поле + признак обязательности в данном
 * направлении (вход/выход). Поля приходят с сервера обогащёнными именем/типом.
 */
export interface RoleFieldRef {
  id: string;
  key: string;
  name: string;
  description: string;
  valueType: FieldValueType;
  /** Обязательное ли поле (для входящих — критично для согласованности маршрута). */
  required: boolean;
}

/** Контракт данных роли (GET /api/roles/:code/fields). */
export interface RoleContract {
  roleCode: string;
  inputs: RoleFieldRef[];
  outputs: RoleFieldRef[];
}

/** Ссылка на поле для сохранения контракта (PUT /api/roles/:code/fields). */
export interface RoleFieldPayload {
  key: string;
  required: boolean;
}

/** Полезная нагрузка сохранения контракта роли. */
export interface RoleContractInput {
  inputs: RoleFieldPayload[];
  outputs: RoleFieldPayload[];
}

/**
 * Результат сохранения контракта роли. `pausedProjects` — коды проектов,
 * поставленных на паузу для пересогласования из-за изменения контракта.
 */
export interface RoleContractSaveResult {
  roleCode: string;
  inputs: RoleFieldRef[];
  outputs: RoleFieldRef[];
  changed: boolean;
  pausedProjects: string[];
}
