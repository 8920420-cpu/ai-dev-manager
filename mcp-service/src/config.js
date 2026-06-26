// MCP-SERVICE-001 — конфигурация сервиса из переменных окружения.
//
// Тонкий адаптер не хранит секретов и не дублирует бизнес-логику: только адреса
// нижележащих сервисов, токен и feature-флаги доступа к мутациям.

/** Привести значение env к boolean: 1/true/yes/on (без учёта регистра) → true. */
export function truthy(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Снять хвостовые '/' у базового URL, чтобы пути склеивались без двойных слэшей. */
function trimUrl(v, fallback) {
  const s = String(v ?? '').trim();
  return (s || fallback).replace(/\/+$/, '');
}

/**
 * Собрать конфиг из env. Значения по умолчанию рассчитаны на локальный запуск из
 * Claude Code / Codex / VS Code (orchestrator на :4186, tools-service на :4188).
 */
export function loadConfig(env = process.env) {
  return {
    projectRoot: String(env.PROJECT_ROOT || process.cwd()),
    orchestratorUrl: trimUrl(env.ORCHESTRATOR_URL, 'http://localhost:4186'),
    toolsServiceUrl: trimUrl(env.TOOLS_SERVICE_URL, 'http://localhost:4188'),
    orchestratorToken: String(env.ORCHESTRATOR_API_TOKEN || '').trim(),
    port: Number(env.MCP_SERVICE_PORT || 4190),
    requestTimeoutMs: Math.max(1000, Number(env.MCP_REQUEST_TIMEOUT_MS || 30000)),
    // Доступ к записи/удалению/мутациям оркестратора — только по явному флагу.
    enableWrite: truthy(env.MCP_ENABLE_WRITE),
    enableDelete: truthy(env.MCP_ENABLE_DELETE),
    enableOrchestratorMutations: truthy(env.MCP_ENABLE_ORCHESTRATOR_MUTATIONS),
  };
}
