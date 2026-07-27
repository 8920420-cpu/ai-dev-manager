// Общий низкоуровневый клиент к оркестратору для хостовых раннеров.
//
// Раньше в каждом bin-демоне (host/programmer/claude-reasoning/codex) дословно
// повторялись: разбор базового URL, фабрика заголовков Bearer и хелпер разбора
// JSON-ответа. Здесь единый источник. Сами наборы эндпоинтов (claim/complete/
// release/needsInput/…) остаются в раннерах — они различаются по ролям.

// Базовый URL оркестратора без хвостовых слешей. Дефолт — локальный докер-порт.
export function resolveOrchestratorBase(env = process.env) {
  return (env.ORCHESTRATOR_URL || 'http://localhost:4186').replace(/\/+$/, '');
}

// Заголовки JSON-запроса с Bearer-токеном (пустой токен → без Authorization).
export function bearerHeaders(token, extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

// Разобрать fetch-ответ как JSON, бросив на не-2xx (с хвостом тела в сообщении).
export async function asJson(res, label) {
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// Выполнить JSON-запрос с таймаутом и нормализацией ошибок в результат-объект
// (НЕ исключение) — вариант из mcp-service для тех, кому нужна устойчивость к сети.
//   { ok:true, status, data } | { ok:false, status, error, code }
// code: 'http_error' | 'timeout' | 'network_error' | 'invalid_json'.
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
