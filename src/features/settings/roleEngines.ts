/**
 * ROLE-ENGINE-ROUTING-001 — общие константы выбора движка рассуждающих ролей.
 * Используются и в разделе «Настройки → Выполнение» (матрица «Движок по ролям»),
 * и в карточке роли (RoleCardModal), чтобы оба места были согласованы и опирались
 * на один источник истины — app_settings.role_engines.
 */
import type { RoleEngine } from '../../api/appSettingsApi';

// Рассуждающие роли, которым можно назначить движок. Программист (CODING) —
// отдельный конвейер Claude Code, здесь не настраивается. Должно соответствовать
// KNOWN_REASONING_ROLES на бэкенде (appSettings.js) — иначе сервер отфильтрует.
export const REASONING_ROLES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'TASK_INTAKE_OFFICER', label: 'Приёмщик задач' },
  { code: 'ARCHITECT', label: 'Архитектор' },
  { code: 'DECOMPOSER', label: 'Декомпозитор' },
  { code: 'TASK_REVIEWER', label: 'Ревьюер' },
  { code: 'FAILURE_ANALYST', label: 'Аналитик провалов' },
  { code: 'DOCUMENTATION_AUDITOR', label: 'Аудитор документации' },
  { code: 'DOCUMENTATION_KEEPER', label: 'Хранитель документации' },
];

export const ENGINE_OPTIONS: ReadonlyArray<{ value: RoleEngine; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek (внутренний)' },
  { value: 'codex', label: 'Codex' },
  { value: 'claude_code', label: 'Claude Code' },
];

const REASONING_ROLE_CODES: ReadonlySet<string> = new Set(REASONING_ROLES.map((r) => r.code));

/** Можно ли роли с таким кодом назначить движок (только рассуждающим). */
export function isReasoningRole(code: string): boolean {
  return REASONING_ROLE_CODES.has(code);
}

/**
 * ROLE-EXEC-TYPE-001 — разделение ролей по ТИПУ ИСПОЛНЕНИЯ. Reasoning-«движок»
 * (матрица DeepSeek/Codex/Claude Code) применим только к рассуждающим ролям;
 * остальные исполняются другими механизмами и не должны показывать выбор движка.
 *
 * host    — исполняет хостовый демон host-runner (PIPELINE_SERVICE, GIT_INTEGRATOR);
 * scanner — файловый/локальный сервис (SCANNER);
 * programmer — отдельный конвейер Claude Code (модель настраивается отдельно, по
 *              сложности задачи в оркестраторе); канонический код роли — PROGRAMMER,
 *              CODING — код стадии того же исполнителя;
 * legacy  — вне активного маршрута (прочие роли).
 */
export const HOST_ROLE_CODES: ReadonlyArray<string> = ['PIPELINE_SERVICE', 'GIT_INTEGRATOR'];
export const SCANNER_ROLE_CODES: ReadonlyArray<string> = ['SCANNER'];
export const PROGRAMMER_ROLE_CODES: ReadonlyArray<string> = ['PROGRAMMER', 'CODING'];

const HOST_ROLE_SET: ReadonlySet<string> = new Set(HOST_ROLE_CODES);
const SCANNER_ROLE_SET: ReadonlySet<string> = new Set(SCANNER_ROLE_CODES);
const PROGRAMMER_ROLE_SET: ReadonlySet<string> = new Set(PROGRAMMER_ROLE_CODES);

export type RoleExecutionType = 'reasoning' | 'programmer' | 'host' | 'scanner' | 'legacy';

/** Тип исполнения роли по её каноническому коду. */
export function roleExecutionType(code: string): RoleExecutionType {
  if (isReasoningRole(code)) return 'reasoning';
  if (PROGRAMMER_ROLE_SET.has(code)) return 'programmer';
  if (HOST_ROLE_SET.has(code)) return 'host';
  if (SCANNER_ROLE_SET.has(code)) return 'scanner';
  return 'legacy';
}

/** Человекочитаемая метка исполнителя для НЕ рассуждающих ролей. */
export const ROLE_EXECUTION_LABEL: Record<Exclude<RoleExecutionType, 'reasoning'>, string> = {
  host: 'исполняется host-runner',
  scanner: 'файловый сервис',
  programmer: 'Claude Code (отдельный конвейер)',
  legacy: 'вне активного маршрута',
};

/**
 * INTEGRATION-ENGINE-UNIFY-001 — провайдеры-«драйверы»: хостовые исполнители
 * рассуждающих ролей (Codex / Claude Code). В разделе «Интеграции» они показаны
 * наравне с API-коннекторами, но не требуют endpoint/токена. Должно совпадать с
 * backend connectors.js (DRIVER_PROVIDERS).
 */
export const DRIVER_PROVIDERS: ReadonlySet<string> = new Set(['codex', 'claude_code']);

export function isDriverProvider(provider: string): boolean {
  return DRIVER_PROVIDERS.has(provider.trim().toLowerCase());
}

/**
 * Тип провайдера коннектора → движок исполнения роли. Объединение полей
 * «Интеграция» и «Движок»: выбор интеграции в карточке роли задаёт исполнителя.
 * Должно совпадать с backend db.js (providerToEngine).
 */
export function providerToEngine(provider: string): RoleEngine {
  const p = provider.trim().toLowerCase();
  if (p === 'codex' || p === 'claude_code') return p;
  return 'deepseek';
}
