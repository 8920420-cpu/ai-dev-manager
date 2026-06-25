// TOOLS-SERVICE-001 — маршрутизация HTTP API микросервиса инструментов.
// Чистая (без сети) функция handleRoute удобна для юнит-тестов; HTTP-обёртка — в bin.
import { executeBuiltin } from './builtins.js';
import { buildMcpConfig } from './mcp.js';

/**
 * Обработать запрос. Возвращает { status, body }.
 *  GET  /health            → проверка живости
 *  POST /execute           → { tool, args } выполнить builtin-инструмент (args.root обязателен)
 *  POST /mcp-config        → { tools:[{name,config}] } собрать MCP-конфиг для Claude Code
 */
export async function handleRoute(method, path, body) {
  if (path === '/health' || path === '/readiness') {
    return { status: 200, body: { status: 'ok', service: 'tools-service' } };
  }

  if (path === '/execute') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    const tool = String(body?.tool ?? '').trim();
    const args = body?.args && typeof body.args === 'object' ? body.args : {};
    if (!tool) return { status: 422, body: { ok: false, error: 'tool_required' } };
    try {
      const result = await executeBuiltin(tool, args);
      return { status: 200, body: { ok: true, tool, result } };
    } catch (e) {
      const status = e.code === 'unknown_tool' ? 404 : 422;
      return { status, body: { ok: false, tool, code: e.code || 'tool_error', error: e.message } };
    }
  }

  if (path === '/mcp-config') {
    if (method !== 'POST') return { status: 405, body: { ok: false, error: 'method_not_allowed' } };
    return { status: 200, body: buildMcpConfig(body?.tools) };
  }

  return { status: 404, body: { ok: false, error: 'not_found' } };
}
