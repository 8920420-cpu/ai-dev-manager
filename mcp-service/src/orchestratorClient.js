// MCP-SERVICE-001 — HTTP-клиент к orchestrator-service.
//
// Тонкий адаптер над реальными эндпоинтами orchestrator-service/backend/src/server.js.
// GET/POST-хелперы, Bearer из ORCHESTRATOR_API_TOKEN, таймаут, нормализация ошибок
// (HTTP-ошибка → объект-результат, процесс не падает).
import { requestJson } from './http.js';

/** Собрать query-string из объекта (пропуская null/undefined). */
function toQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/**
 * Создать клиента orchestrator-service.
 *   baseUrl  — например http://localhost:4186
 *   token    — Bearer из ORCHESTRATOR_API_TOKEN (если /api закрыт токеном)
 *   timeoutMs, fetchImpl — таймаут и тесты.
 * Возвращает { get, post, request } — каждый отдаёт { ok, status, data } | { ok:false, error, code, status }.
 */
export function createOrchestratorClient({ baseUrl, token = '', timeoutMs = 30000, fetchImpl = fetch } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const headers = token ? { authorization: `Bearer ${token}` } : {};

  function request(method, path, { body, query } = {}) {
    const url = `${base}${path}${toQuery(query)}`;
    return requestJson(url, { method, headers, body, timeoutMs, fetchImpl });
  }

  return {
    baseUrl: base,
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, body, opts) => request('POST', path, { ...opts, body: body ?? {} }),
  };
}
