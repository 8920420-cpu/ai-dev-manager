// Клиент внешнего AI-коннектора (DeepSeek / OpenAI-совместимые chat API).
// Портирован 1:1 из Connector_Service (Go) internal/services/llm_connector_client.go.
// Чистые функции (buildRequest/parseLLMResponse/normalize*) покрыты тестами и
// не зависят от сети — это упрощает проверку «точно такой же» логики.

import { acquire, recordResult, classifyOutcome } from './connectorLimiter.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 минут, как в источнике
const RESPONSE_LIMIT_BYTES = 4 << 20; // 4 МБ

// CONNECTOR-LIMITER-001: число повторов на ретраябельных сбоях (429/5xx/сеть).
function envInt(name, def) {
  const n = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
}
const RETRY_MAX = Math.max(0, envInt('CONNECTOR_RETRY_MAX', 1));
const RETRY_BASE_MS = Math.max(50, envInt('CONNECTOR_RETRY_BASE_MS', 500));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => RETRY_BASE_MS * 2 ** attempt + Math.floor(Math.random() * RETRY_BASE_MS);

// Извлечь число использованных токенов из ответа OpenAI-совместимого API.
function extractUsageTokens(raw) {
  try {
    const j = JSON.parse(raw);
    const u = j?.usage;
    if (!u) return 0;
    if (Number.isFinite(u.total_tokens)) return u.total_tokens;
    return (Number(u.prompt_tokens) || 0) + (Number(u.completion_tokens) || 0);
  } catch {
    return 0;
  }
}

// Единый сетевой вызов модели под глобальным лимитером + ретрай. Захватывает
// слот, делает fetch, фиксирует исход (для AIMD/учёта токенов), освобождает слот.
// Возвращает { status, raw, durationMs } на 2xx; иначе бросает Error (с httpStatus).
async function networkCall(conn, { endpoint, body, headers, timeoutMs }) {
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_MAX; attempt += 1) {
    const release = await acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
      const raw = await res.text();
      const durationMs = Date.now() - started;
      clearTimeout(timer);
      release();
      if (res.status < 200 || res.status >= 300) {
        const outcome = classifyOutcome({ httpStatus: res.status });
        recordResult({ outcome, totalTokens: 0 });
        const err = new Error(`connector "${conn.name}": HTTP ${res.status}: ${truncateErrBody(raw)}`);
        err.httpStatus = res.status;
        err.durationMs = durationMs;
        if (outcome === 'throttle' && attempt < RETRY_MAX) {
          lastError = err;
          await sleep(backoffMs(attempt));
          continue;
        }
        throw err;
      }
      recordResult({ outcome: 'ok', totalTokens: extractUsageTokens(raw) });
      return { status: res.status, raw, durationMs };
    } catch (e) {
      clearTimeout(timer);
      release();
      if (e?.httpStatus) throw e; // уже обработанный HTTP-ответ выше
      const durationMs = Date.now() - started;
      const aborted = e?.name === 'AbortError';
      const msg = aborted ? `AI response timeout (${timeoutMs}ms)` : (e?.message || 'network error');
      recordResult({ outcome: classifyOutcome({ aborted, errorMessage: msg }), totalTokens: 0 });
      const err = new Error(`connector "${conn.name}": ${msg}`);
      err.durationMs = durationMs;
      // Таймаут/abort не ретраим: бюджет роли уже потрачен. Сетевые — ретраим.
      if (!aborted && attempt < RETRY_MAX) {
        lastError = err;
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new Error(`connector "${conn.name}": network call failed`);
}

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

  const headers = { 'Content-Type': 'application/json' };
  const token = String(conn.accessToken ?? '').trim();
  if (token !== '') headers['Authorization'] = 'Bearer ' + token;

  // Сеть под глобальным лимитером (семафор + AIMD + учёт токенов) и ретраем.
  const { status, raw, durationMs } = await networkCall(conn, { endpoint, body, headers, timeoutMs });

  if (raw.length > RESPONSE_LIMIT_BYTES) {
    throw new Error(`connector "${conn.name}": response too large`);
  }
  let text;
  try {
    text = parseLLMResponse(raw);
  } catch (e) {
    const err = new Error(`connector "${conn.name}": ${e.message}`);
    err.httpStatus = status;
    err.durationMs = durationMs;
    throw err;
  }
  if (String(text).trim() === '') {
    throw new Error(`connector "${conn.name}": empty response`);
  }
  return { text, httpStatus: status, durationMs };
}

/**
 * Чат с поддержкой инструментов (function calling). messages — массив
 * { role, content, tool_calls?, tool_call_id? } в формате OpenAI. tools — список
 * function-схем. Возвращает { message, httpStatus, durationMs }, где message —
 * ответ ассистента (content и/или tool_calls). Для НЕ-OpenAI-совместимых
 * коннекторов tools не поддерживаются — деградируем до обычного invoke (без tools).
 */
export async function invokeChat(conn, { messages, tools = [] }, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let endpoint = String(conn.endpoint ?? '').trim();
  if (endpoint === '') throw new Error(`connector "${conn.name}": empty endpoint`);

  if (!usesOpenAIChatAPI(endpoint)) {
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const usr = messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n\n');
    const { text, httpStatus, durationMs } = await invoke(conn, { system: sys, user: usr }, { timeoutMs });
    return { message: { role: 'assistant', content: text, tool_calls: [] }, httpStatus, durationMs };
  }

  endpoint = normalizeChatCompletionsEndpoint(endpoint);
  const model = defaultModelForEndpoint(endpoint, conn.model);
  const req = { model, messages, temperature: 0, max_tokens: openAIMaxTokens() };
  // С tools НЕ включаем response_format json_object — он конфликтует с tool_calls.
  if (Array.isArray(tools) && tools.length) {
    req.tools = tools;
    req.tool_choice = 'auto';
  }

  const headers = { 'Content-Type': 'application/json' };
  const token = String(conn.accessToken ?? '').trim();
  if (token !== '') headers['Authorization'] = 'Bearer ' + token;

  // Сеть под глобальным лимитером (семафор + AIMD + учёт токенов) и ретраем.
  const { status, raw, durationMs } = await networkCall(conn, {
    endpoint, body: JSON.stringify(req), headers, timeoutMs,
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { message: { role: 'assistant', content: raw, tool_calls: [] }, httpStatus: status, durationMs };
  }
  const message = parsed?.choices?.[0]?.message ?? { role: 'assistant', content: '' };
  if (!Array.isArray(message.tool_calls)) message.tool_calls = [];
  return { message, httpStatus: status, durationMs };
}

// Экспорт внутренних чистых функций для тестов.
export const _internal = {
  usesOpenAIChatAPI,
  normalizeChatCompletionsEndpoint,
  defaultModelForEndpoint,
  ensureUserPromptMentionsJSON,
};
