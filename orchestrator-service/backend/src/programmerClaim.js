import { isDriverProvider } from './connectors.js';

const PROGRAMMER_MODEL_SIMPLE = String(process.env.PROGRAMMER_MODEL_SIMPLE || 'claude-sonnet-5').trim();
const PROGRAMMER_MODEL_COMPLEX = String(process.env.PROGRAMMER_MODEL_COMPLEX || 'claude-opus-4-8').trim();

export const PROGRAMMER_COMPLETION_INSTRUCTION =
  'ОБЯЗАТЕЛЬНО: сразу после внесения изменений вызови ' +
  'orchestrator_complete_scanner_task с этими taskId, completionKey, ' +
  'project, service, title, sourceDocument; перечисли changedFiles и ' +
  'result. Не оставляй задачу без рапорта — иначе она зависнет на этапе ' +
  'Programmer (CODING) и затормозит весь пайплайн. После успешной сдачи ' +
  'результата очисти рабочий контекст сессии программиста (например, ' +
  'командой /clear в Claude Code), чтобы следующая задача не получила ' +
  'остатки контекста выполненной задачи.';

export function programmerModelForKind(taskKind) {
  return String(taskKind) === 'subtask' ? PROGRAMMER_MODEL_SIMPLE : PROGRAMMER_MODEL_COMPLEX;
}

// STACK-SPECIALIZATION-001 — специализация программиста ДАННЫМИ, а не отдельными
// ролями: одна роль PROGRAMMER, а «Go-бэкенд / proto-контракт / Next-фронтенд»
// различаются полем `stack` задачи. Раннер по нему подаёт агенту профиль скилов
// (см. programmer-runner/src/skillProfiles.js). Отдельные роли на каждый стек дали
// бы узлы графа с бэкфиллом по всем проектам, три демона и разрыв KPI роли, но НЕ
// дали бы параллельности: она упирается в замок микросервиса
// (WORK-STACK-001 + PROGRAMMER-WORKTREE-PER-SERVICE), а не в число ролей.
const STACK_ALIASES = new Map([
  ['go', 'go'], ['golang', 'go'], ['backend', 'go'], ['back', 'go'], ['бэкенд', 'go'],
  ['proto', 'proto'], ['protobuf', 'proto'], ['grpc', 'proto'], ['contract', 'proto'],
  ['контракт', 'proto'],
  ['next', 'next'], ['nextjs', 'next'], ['next.js', 'next'], ['react', 'next'],
  ['frontend', 'next'], ['front', 'next'], ['ui', 'next'], ['фронтенд', 'next'],
]);

/** Нормализовать стек к go|proto|next. Мусор/пусто → null (раннер решит эвристикой). */
export function normalizeStack(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return STACK_ALIASES.get(raw) ?? null;
}

/**
 * Стек задачи из её карточки. Приоритет — work_items (Архитектор проставляет стек
 * ПО СЕРВИСУ, и карточка ребёнка уже отфильтрована под его сервис), затем общее
 * поле карточки. Ничего валидного → null: раннер определит стек эвристикой сам.
 *
 * @param {Object|string|null} dataCard tasks.data_card
 * @returns {'go'|'proto'|'next'|null}
 */
export function resolveTaskStack(dataCard) {
  let card = dataCard;
  if (typeof card === 'string') {
    try { card = JSON.parse(card); } catch { return null; }
  }
  if (!card || typeof card !== 'object') return null;
  const items = Array.isArray(card.work_items) ? card.work_items : [];
  for (const item of items) {
    const fromItem = normalizeStack(item?.stack);
    if (fromItem) return fromItem;
  }
  return normalizeStack(card.stack);
}

export function buildProgrammerRunSnapshot({ connectorRow = null, agentRow = null, taskKind = null } = {}) {
  const connModel = String(connectorRow?.model ?? '').trim();
  const agentModel = String(agentRow?.model ?? '').trim();
  const routedModel = programmerModelForKind(taskKind);
  const model = connModel || routedModel || agentModel || null;
  const provider = connectorRow?.provider == null ? null : String(connectorRow.provider);

  return {
    model,
    snapshot: {
      connectorId: connectorRow?.connector_id ?? null,
      provider,
      model,
      driverType: provider == null ? null : (isDriverProvider(provider) ? 'driver' : 'api'),
    },
  };
}

export function buildProgrammerClaimTask({
  row,
  projectCode,
  serviceCode,
  model,
  prior,
  tools,
  mcpConfig,
  requiredFields,
  completionKey,
  stack = null,
  completionInstruction = PROGRAMMER_COMPLETION_INSTRUCTION,
}) {
  return {
    id: row.id,
    project: projectCode,
    service: serviceCode ?? '',
    title: row.title,
    description: row.description ?? '',
    model,
    // STACK-SPECIALIZATION-001: подсказка раннеру, какой профиль скилов подать
    // агенту. null — раннер определит стек эвристикой по описанию задачи.
    stack,
    priorRoleOutputs: prior.priorRoleOutputs,
    lastReview: prior.lastReview,
    capabilities: tools.capabilities,
    mcpConfig,
    requiredFields,
    completion: {
      required: true,
      tool: 'orchestrator_complete_scanner_task',
      completionKey,
      project: projectCode,
      service: serviceCode ?? '',
      title: row.title,
      sourceDocument: 'tasks/claude-tasks.json',
      instruction: completionInstruction,
    },
  };
}
