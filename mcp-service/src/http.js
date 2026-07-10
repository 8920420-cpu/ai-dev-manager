// MCP-SERVICE-001 — общий HTTP-помощник с таймаутом и нормализацией ошибок.
//
// Любая сетевая/HTTP-ошибка превращается в обычный объект-результат, а НЕ в
// исключение, которое могло бы уронить MCP-процесс. fetchImpl инъектируется для
// юнит-тестов (по умолчанию — глобальный fetch Node 18+).

/**
 * Выполнить JSON-запрос. Возвращает нормализованный результат:
 *   { ok: true,  status, data }
 *   { ok: false, status, error, code }
 * code: 'http_error' (ответ с не-2xx), 'timeout' (превышен timeout),
 *       'network_error' (сеть/DNS), 'invalid_json' (тело не распарсилось).
 */
export async function requestJson(
  url,
  { method = 'GET', body, headers = {}, timeoutMs = 30000, fetchImpl = fetch } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const init = { method, headers: { ...headers }, signal: controller.signal };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchImpl(url, init);
  } catch (e) {
    clearTimeout(timer);
    const aborted = e?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      code: aborted ? 'timeout' : 'network_error',
      error: aborted ? `Таймаут запроса (${timeoutMs} ms): ${url}` : `Сетевая ошибка: ${e?.message || e}`,
    };
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  let data;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      // Не-JSON тело (например, статика 404) — отдаём как текст, без падения.
      data = { raw: text };
      if (res.ok) {
        return { ok: false, status: res.status, code: 'invalid_json', error: 'Ответ не является JSON', data };
      }
    }
  } else {
    data = null;
  }

  if (!res.ok) {
    const error =
      (data && (data.error || data.message)) || `HTTP ${res.status} ${res.statusText || ''}`.trim();
    const code = (data && data.code) || 'http_error';
    return { ok: false, status: res.status, code, error, data };
  }

  return { ok: true, status: res.status, data };
}
