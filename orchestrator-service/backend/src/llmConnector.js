// Клиент внешнего AI-коннектора (DeepSeek / OpenAI-совместимые chat API).
// Портирован 1:1 из Connector_Service (Go) internal/services/llm_connector_client.go.
// Чистые функции (buildRequest/parseLLMResponse/normalize*) покрыты тестами и
// не зависят от сети — это упрощает проверку «точно такой же» логики.

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут, как в источнике
const RESPONSE_LIMIT_BYTES = 4 << 20; // 4 МБ

// --- настройки через окружение (аналог os.Getenv в источнике) -------------

function envTrim(name) {
  return String(process.env[name] ?? '').trim();
}

function openAIJSONMode() {
  const raw = envTrim('CONNECTOR_LLM_JSON_MODE');
  if (raw === '') return true;
  switch (raw.toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return true;
  }
}

function openAIMaxTokens() {
  const defaultMax = 8192;
  const raw = envTrim('CONNECTOR_LLM_MAX_TOKENS');
  if (raw === '') return defaultMax;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1024) return defaultMax;
  return n;
}

function usesOpenAIChatAPI(endpoint) {
  const lower = endpoint.toLowerCase();
  if (lower.includes('deepseek.com') || lower.includes('openai.com')) return true;
  if (lower.includes('/v1') && !lower.includes('completions')) return true;
  return envTrim('CONNECTOR_LLM_OPENAI_COMPAT') === '1';
}

function normalizeChatCompletionsEndpoint(endpoint) {
  endpoint = endpoint.trim().replace(/\/+$/, '');
  if (endpoint.endsWith('/chat/completions')) return endpoint;
  if (endpoint.endsWith('/v1')) return endpoint + '/chat/completions';
  let u;
  try {
    u = new URL(endpoint);
  } catch {
    return endpoint + '/chat/completions';
  }
  const path = u.pathname.replace(/\/+$/, '');
  if (path === '' || path === '/') {
    u.pathname = path + '/chat/completions';
    return u.toString();
  }
  return endpoint;
}

// Модель по умолчанию для endpoint (можно явно задать на коннекторе).
function defaultModelForEndpoint(endpoint, explicitModel) {
  const m = String(explicitModel ?? '').trim();
  if (m !== '') return m;
  const lower = endpoint.toLowerCase();
  if (lower.includes('deepseek.com')) {
    return envTrim('CONNECTOR_DEEPSEEK_MODEL') || 'deepseek-chat';
  }
  return envTrim('CONNECTOR_OPENAI_MODEL') || 'gpt-4o-mini';
}

const OPENAI_JSON_MODE_USER_HINT = '\n\nRespond with valid json only.';

function userMessageMentionsJSON(messages) {
  return messages.some((m) => m.role === 'user' && m.content.toLowerCase().includes('json'));
}

// Deepseek (и часть OpenAI-совместимых API) отклоняют json_object, если слово
// "json" есть только в system, а user — чистый payload без него.
function ensureUserPromptMentionsJSON(messages) {
  if (userMessageMentionsJSON(messages)) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== 'user') continue;
    out[i].content = out[i].content.replace(/\n+$/, '') + OPENAI_JSON_MODE_USER_HINT;
    return out;
  }
  out.push({ role: 'user', content: OPENAI_JSON_MODE_USER_HINT.replace(/^\n\n/, '') });
  return out;
}

/**
 * Построить запрос к коннектору. Возвращает { endpoint, body } (body — строка JSON).
 * conn: { name, endpoint, model, consumerService }
 * input: { system, user }
 */
export function buildRequest(conn, input) {
  let endpoint = String(conn.endpoint ?? '').trim();
  if (endpoint === '') throw new Error(`connector "${conn.name}": empty endpoint`);

  let system = String(input.system ?? '').trim();
  let user = String(input.user ?? '').trim();
  if (system === '' && user === '') {
    throw new Error(`connector "${conn.name}": empty prompt`);
  }
  if (user === '') {
    user = system;
    system = '';
  }

  if (usesOpenAIChatAPI(endpoint)) {
    endpoint = normalizeChatCompletionsEndpoint(endpoint);
    const model = defaultModelForEndpoint(endpoint, conn.model);
    let messages = [];
    if (system !== '') messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });

    const req = {
      model,
      messages,
      max_tokens: openAIMaxTokens(),
      temperature: 0,
    };
    if (openAIJSONMode()) {
      req.response_format = { type: 'json_object' };
      messages = ensureUserPromptMentionsJSON(messages);
    }
    req.messages = messages;
    return { endpoint, body: JSON.stringify(req) };
  }

  // Generic коннектор: единый prompt + consumer_service.
  let prompt = user;
  if (system !== '') prompt = system + '\n\n' + user;
  return {
    endpoint,
    body: JSON.stringify({ prompt, consumer_service: conn.consumerService ?? '' }),
  };
}

function truncateErrBody(raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return '(empty body)';
  if (s.length > 280) return s.slice(0, 280) + '…';
  return s;
}

function decodeJSONString(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

/**
 * Извлечь текст ответа из тела (string | OpenAI choices | generic поля).
 * Бросает Error при error-объекте от API.
 */
export function parseLLMResponse(raw) {
  const trimmed = String(raw ?? '').trim();
  if (trimmed === '') throw new Error('empty body');
  if (trimmed[0] !== '{' && trimmed[0] !== '[') return trimmed;

  let generic;
  try {
    generic = JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
  if (generic === null || typeof generic !== 'object') return trimmed;

  for (const key of ['response', 'answer', 'content', 'text', 'message', 'result']) {
    if (key in generic) {
      const s = decodeJSONString(generic[key]);
      if (s !== '') return s;
    }
  }

  if (Array.isArray(generic.choices) && generic.choices.length > 0) {
    const first = generic.choices[0];
    if (first && typeof first.message === 'object' && first.message) {
      const c = decodeJSONString(first.message.content);
      if (c !== '') return c;
      const r = decodeJSONString(first.message.reasoning_content);
      if (r !== '') return r;
    }
    const t = decodeJSONString(first?.text);
    if (t !== '') return t;
  }

  if ('error' in generic) {
    const s = decodeJSONString(generic.error);
    if (typeof generic.error === 'string' && s !== '') {
      throw new Error(`api error: ${s}`);
    }
    if (generic.error && typeof generic.error === 'object') {
      const m = decodeJSONString(generic.error.message);
      if (m !== '') throw new Error(`api error: ${m}`);
    }
  }

  return trimmed;
}

/**
 * Отправить промт на endpoint коннектора и вернуть текст ответа + метаданные.
 * conn: { name, endpoint, accessToken, model, consumerService }
 * input: { system, user }
 * Возвращает { text, httpStatus, durationMs }. Бросает Error при сбое.
 */
export async function invoke(conn, input, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { endpoint, body } = buildRequest(conn, input);
  const started = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = { 'Content-Type': 'application/json' };
  const token = String(conn.accessToken ?? '').trim();
  if (token !== '') headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') {
      throw new Error(`connector "${conn.name}": AI response timeout (${timeoutMs}ms)`);
    }
    throw new Error(`connector "${conn.name}": request failed: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  const durationMs = Date.now() - started;

  if (res.status < 200 || res.status >= 300) {
    const err = new Error(
      `connector "${conn.name}": HTTP ${res.status}: ${truncateErrBody(raw)}`,
    );
    err.httpStatus = res.status;
    err.durationMs = durationMs;
    throw err;
  }
  if (raw.length > RESPONSE_LIMIT_BYTES) {
    throw new Error(`connector "${conn.name}": response too large`);
  }

  let text;
  try {
    text = parseLLMResponse(raw);
  } catch (e) {
    const err = new Error(`connector "${conn.name}": ${e.message}`);
    err.httpStatus = res.status;
    err.durationMs = durationMs;
    throw err;
  }
  if (String(text).trim() === '') {
    throw new Error(`connector "${conn.name}": empty response`);
  }
  return { text, httpStatus: res.status, durationMs };
}

// Экспорт внутренних чистых функций для тестов.
export const _internal = {
  usesOpenAIChatAPI,
  normalizeChatCompletionsEndpoint,
  defaultModelForEndpoint,
  ensureUserPromptMentionsJSON,
};
