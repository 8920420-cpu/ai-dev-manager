// MCP-SERVICE-001 — HTTP-клиент к tools-service (builtin-инструменты проекта).
//
// Тонкий адаптер: вызывает POST /execute { tool, args } и нормализует ответ.
// Песочница и файловая логика остаются в tools-service; здесь только транспорт.
import { requestJson } from './http.js';

/**
 * Создать клиента tools-service.
 *   baseUrl  — например http://localhost:4188
 *   token    — опциональный Bearer (ORCHESTRATOR_API_TOKEN), если сервис закрыт
 *   timeoutMs, fetchImpl — для таймаута и тестов.
 */
export function createToolsClient({ baseUrl, token = '', timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  /**
   * Выполнить builtin-инструмент. args обязан содержать `root` (корень проекта).
   * Возвращает { ok: true, data } | { ok: false, error, code, status }.
   * tools-service отвечает { ok, tool, result } / { ok:false, tool, code, error };
   * приводим к единому { ok, data }.
   */
  async function execute(tool, args = {}) {
    const r = await requestJson(`${base}/execute`, {
      method: 'POST',
      headers,
      body: { tool, args },
      timeoutMs,
      fetchImpl,
    });
    if (!r.ok) {
      return { ok: false, error: r.error, code: r.code, status: r.status };
    }
    const payload = r.data || {};
    // Уровень приложения tools-service может вернуть ok:false с 200 (валидация).
    if (payload.ok === false) {
      return { ok: false, error: payload.error, code: payload.code || 'tool_error', status: r.status };
    }
    return { ok: true, data: payload.result ?? payload };
  }

  return { execute, baseUrl: base };
}
