// TOOLS-SERVICE-001 — сборка MCP-конфигурации для Claude Code.
//
// Из набора tool'ов вида { name, config } собирает объект `.mcp.json`/--mcp-config:
//   { "mcpServers": { "<name>": { command, args, env } | { url } } }
// Поддерживаем stdio (command/args/env) и http/sse (url). Невалидные записи
// пропускаются (без падения), чтобы один кривой tool не сломал весь конфиг.

function trimOrNull(v) {
  const s = String(v ?? '').trim();
  return s.length ? s : null;
}

/** Нормализовать одну MCP-запись в формат mcpServers. null — если невалидна. */
export function toMcpServer(config = {}) {
  const url = trimOrNull(config.url);
  if (url) {
    // HTTP/SSE-сервер.
    const out = { url };
    if (trimOrNull(config.transport)) out.transport = trimOrNull(config.transport);
    if (config.headers && typeof config.headers === 'object') out.headers = config.headers;
    return out;
  }
  const command = trimOrNull(config.command);
  if (command) {
    const out = { command };
    if (Array.isArray(config.args)) out.args = config.args.map(String);
    if (config.env && typeof config.env === 'object') out.env = config.env;
    return out;
  }
  return null; // ни url, ни command — не MCP-сервер
}

/**
 * Собрать MCP-конфиг из списка tool'ов. tools: [{ name, config }].
 * Возвращает { mcpServers: {...} }. Безымянные/невалидные записи пропускаются.
 */
export function buildMcpConfig(tools = []) {
  const mcpServers = {};
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = trimOrNull(tool?.name);
    if (!name) continue;
    const server = toMcpServer(tool?.config ?? {});
    if (server) mcpServers[name] = server;
  }
  return { mcpServers };
}
