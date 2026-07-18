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
  completionInstruction = PROGRAMMER_COMPLETION_INSTRUCTION,
}) {
  return {
    id: row.id,
    project: projectCode,
    service: serviceCode ?? '',
    title: row.title,
    description: row.description ?? '',
    model,
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
