// LOGGING-STANDARD-001 — маскирование секретов/PII и ограничение размеров.
//
// Правило проекта (§9 стандарта): в лог НЕ должны попадать пароли, токены, cookies,
// Authorization-заголовки, строки подключения, приватные ключи, полные тела запросов.
// redact() — «предохранитель»: даже если такое поле случайно приложили к событию,
// его значение будет замаскировано ПЕРЕД сериализацией.

const REDACTED = '[REDACTED]';

// Имена полей, значение которых маскируется целиком (сравнение по нормализованному
// ключу: нижний регистр, без разделителей `-_` и пробелов).
export const SECRET_KEYS = new Set([
  'password', 'passwd', 'pass', 'pwd', 'pgpassword',
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'apitoken', 'apikey',
  'authorization', 'auth', 'cookie', 'setcookie', 'xapitoken', 'xintaketoken',
  'secret', 'clientsecret', 'privatekey', 'sessionkey',
  'connectionstring', 'dsn', 'databaseurl', 'creditcard', 'cardnumber', 'cvv',
]);

// Заголовки, которые можно логировать как есть (allowlist). Остальные заголовки
// либо маскируются (secret), либо опускаются — тела/куки в лог не кладём.
export const HEADER_ALLOWLIST = new Set([
  'host', 'user-agent', 'content-type', 'content-length', 'accept',
  'x-request-id', 'x-correlation-id', 'traceparent', 'referer', 'x-forwarded-for',
]);

// Маскирование секретов, встречающихся в свободном тексте message/raw.
const INLINE_PATTERNS = [
  [/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, '$1[REDACTED]'],
  [/(authorization["'\s:=]+)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, '[REDACTED]'],
  [/(password["'\s:=]+)[^\s"',}]+/gi, '$1[REDACTED]'],
  [/(postgres(?:ql)?:\/\/[^:]+:)[^@]+(@)/gi, '$1[REDACTED]$2'],
];

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[\s\-_]/g, '');
}

export function isSecretKey(key) {
  return SECRET_KEYS.has(normalizeKey(key));
}

/** Замаскировать секреты в свободной строке (message/raw). */
export function redactString(value, maxLen = 8192) {
  let s = String(value);
  for (const [re, rep] of INLINE_PATTERNS) s = s.replace(re, rep);
  if (s.length > maxLen) s = `${s.slice(0, maxLen)}…(+${s.length - maxLen})`;
  return s;
}

/**
 * Рекурсивно замаскировать секретные поля и ограничить размеры.
 * - секретные ключи → [REDACTED];
 * - строки > maxStringLen → усечение с пометкой длины;
 * - глубина/размер массива ограничены (защита от неограниченно растущих полей).
 */
export function redact(input, { maxStringLen = 8192, maxDepth = 8, maxArray = 200 } = {}) {
  const seen = new WeakSet();
  function walk(value, depth, keyHint) {
    if (value == null) return value;
    if (typeof value === 'string') {
      const masked = /message|msg|raw|text|reason|error_message|stack/.test(String(keyHint || ''))
        ? redactString(value, maxStringLen)
        : value;
      return masked.length > maxStringLen ? `${masked.slice(0, maxStringLen)}…(+${masked.length - maxStringLen})` : masked;
    }
    if (typeof value !== 'object') return value;
    if (depth >= maxDepth) return '[TRUNCATED_DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (Array.isArray(value)) {
      const arr = value.slice(0, maxArray).map((v) => walk(v, depth + 1));
      if (value.length > maxArray) arr.push(`…(+${value.length - maxArray} items)`);
      return arr;
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSecretKey(k) ? REDACTED : walk(v, depth + 1, k);
    }
    return out;
  }
  return walk(input, 0);
}

/** Отфильтровать заголовки по allowlist, секретные — замаскировать. */
export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lower = k.toLowerCase();
    if (isSecretKey(k)) out[lower] = REDACTED;
    else if (HEADER_ALLOWLIST.has(lower)) out[lower] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}
