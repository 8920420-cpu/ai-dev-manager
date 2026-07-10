// ROLE-FIELD-CONTRACT-001 — чистый валидатор контракта полей и работа с
// карточкой данных задачи. Без БД и сети — покрыт юнит-тестами.
//
// Контракт роли НЕОБЯЗАТЕЛЕН: роль без объявленных полей — сквозной проход
// (ничего не требует и ничего не гарантирует; карточка проходит как есть).
//
// Главная проверка — DESIGN-TIME согласованность схемы: для каждого обязательного
// ВХОДЯЩЕГО поля роли на позиции N в маршруте проекта должно существовать
// ИСХОДЯЩЕЕ поле какой-то роли на позиции < N (карточка персистентна и
// кумулятивна) либо начальное поле карточки (seed: title/description). Иначе
// схему сохранить нельзя.

import { asObject } from './dataCard.js';

// Начальные поля карточки, доступные с создания задачи (до первой роли).
export const SEED_FIELDS = ['title', 'description'];

// Поле «заполнено»: непустая строка/ненулевое значение/непустой массив/объект.
export function isFilled(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true; // number/boolean — заполнено (в т.ч. 0/false)
}

// Нормализовать контракт роли к { inputs:[{key,required}], outputs:[{key,required}] }.
function normContract(contract) {
  const arr = (x) => (Array.isArray(x) ? x : []);
  const norm = (list) =>
    arr(list)
      .map((f) => (typeof f === 'string' ? { key: f, required: true } : { key: String(f?.key ?? ''), required: f?.required !== false }))
      .filter((f) => f.key);
  return { inputs: norm(contract?.inputs), outputs: norm(contract?.outputs) };
}

/**
 * DESIGN-TIME проверка согласованности маршрута проекта по полям.
 * route: упорядоченный список включённых ролей [{ roleCode }] (как из buildRoute,
 *        отфильтрованный по stageEnabled — порядок ВАЖЕН).
 * contractsByRole: Map|Object roleCode → { inputs, outputs } (контракты ролей).
 * seedFields: ключи, доступные с начала (по умолчанию SEED_FIELDS).
 * Возвращает массив ошибок [{ roleCode, field, code, message }] (пустой — ок).
 */
export function validateFieldConsistency(route, contractsByRole, { seedFields = SEED_FIELDS } = {}) {
  const get = (code) =>
    contractsByRole instanceof Map ? contractsByRole.get(code) : contractsByRole?.[code];
  const produced = new Set(seedFields);
  const errors = [];
  for (const entry of Array.isArray(route) ? route : []) {
    const code = entry?.roleCode;
    if (!code) continue;
    const { inputs, outputs } = normContract(get(code));
    for (const inp of inputs) {
      if (inp.required && !produced.has(inp.key)) {
        errors.push({
          roleCode: code,
          field: inp.key,
          code: 'field_not_produced_upstream',
          message: `Роль ${code} требует поле «${inp.key}», но его не производит ни одна предшествующая роль маршрута.`,
        });
      }
    }
    // Исходящие поля роли становятся доступны следующим ролям (кумулятивно).
    for (const out of outputs) produced.add(out.key);
  }
  return errors;
}

/**
 * Извлечь значения объявленных ИСХОДЯЩИХ полей роли из её результата.
 * source — объект значений (verdict.fields, либо payload completion/host).
 * outputs — объявленные исходящие поля роли [{ key, required }] | [key].
 * Возвращает { values: {key:value}, missingRequired: [key] } — только непустые
 * значения пишутся; обязательные незаполненные собираются в missingRequired.
 */
export function extractOutputs(source, outputs) {
  const { outputs: outs } = normContract({ outputs });
  const src = asObject(source);
  const values = {};
  const missingRequired = [];
  for (const out of outs) {
    const v = src[out.key];
    if (isFilled(v)) values[out.key] = v;
    else if (out.required) missingRequired.push(out.key);
  }
  return { values, missingRequired };
}

/**
 * RUNTIME-проверка обязательных ВХОДЯЩИХ полей роли по карточке задачи.
 * card — карточка значений {key:value} (включая seed). inputs — контракт входа.
 * Возвращает массив отсутствующих обязательных ключей (пустой — ок).
 */
export function missingRequiredInputs(card, inputs, { seedFields = SEED_FIELDS } = {}) {
  const { inputs: ins } = normContract({ inputs });
  const data = asObject(card);
  const missing = [];
  for (const inp of ins) {
    if (!inp.required) continue;
    if (isFilled(data[inp.key])) continue;
    if (seedFields.includes(inp.key)) continue; // seed считаем заполненным извне
    missing.push(inp.key);
  }
  return missing;
}
