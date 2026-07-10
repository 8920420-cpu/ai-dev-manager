// Rate limiting для публичного Catalog API.
// Реализовано по проекту ARCHITECT (token bucket, настраиваемые лимиты,
// метрики; без изменения схемы БД/контрактов) и разбивке DECOMPOSER
// (1: конфигурация лимитов, 2: middleware, 3: метрики/логирование).

// --- Подзадача 1: конфигурация лимитов -------------------------------------
// Лимиты задаются на класс клиента; по умолчанию анонимные жёстче авторизованных.
export const DEFAULT_LIMITS = {
  anonymous: { capacity: 30, refillPerSec: 0.5 }, // burst 30, ~30 запросов/мин
  authenticated: { capacity: 120, refillPerSec: 2 }, // burst 120, ~120 запросов/мин
};

export function resolveLimit(limits, clientClass) {
  return limits[clientClass] ?? limits.anonymous;
}

// --- Token bucket -----------------------------------------------------------
// Чистая, детерминированная (now инъектируется) реализация ведра токенов.
export function createTokenBucket({ capacity, refillPerSec, now = () => Date.now() }) {
  if (!(capacity > 0)) throw new Error('capacity must be > 0');
  if (!(refillPerSec >= 0)) throw new Error('refillPerSec must be >= 0');
  let tokens = capacity;
  let last = now();

  function refill() {
    const t = now();
    const elapsedSec = Math.max(0, (t - last) / 1000);
    if (elapsedSec > 0) {
      tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
      last = t;
    }
  }

  return {
    // Попытаться списать n токенов. Возвращает решение и сколько ждать при отказе.
    tryRemove(n = 1) {
      refill();
      if (tokens >= n) {
        tokens -= n;
        return { allowed: true, remaining: Math.floor(tokens), retryAfterMs: 0 };
      }
      const deficit = n - tokens;
      const retryAfterMs = refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : Infinity;
      return { allowed: false, remaining: Math.floor(tokens), retryAfterMs };
    },
    peek() {
      refill();
      return Math.floor(tokens);
    },
  };
}

// --- Реестр вёдер по ключу клиента -----------------------------------------
export function createLimiterRegistry({ limits = DEFAULT_LIMITS, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return {
    bucketFor(key, clientClass) {
      const id = `${clientClass}:${key}`;
      let b = buckets.get(id);
      if (!b) {
        b = createTokenBucket({ ...resolveLimit(limits, clientClass), now });
        buckets.set(id, b);
      }
      return b;
    },
    size() {
      return buckets.size;
    },
  };
}

// --- Подзадача 3: метрики ---------------------------------------------------
export function createMetrics() {
  const counters = { allowed: 0, blocked: 0 };
  return {
    inc(kind) {
      if (kind in counters) counters[kind] += 1;
    },
    snapshot() {
      return { ...counters };
    },
  };
}

// --- Подзадача 2: middleware -----------------------------------------------
// Express-совместимый middleware. clientKey/clientClass извлекаются из запроса
// (по умолчанию: ip + наличие авторизации). Логирование — инъектируемый log.
export function rateLimitMiddleware({
  limits = DEFAULT_LIMITS,
  now = () => Date.now(),
  metrics = createMetrics(),
  log = null,
  clientKey = (req) => req.ip ?? 'unknown',
  clientClass = (req) => (req.user || req.headers?.authorization ? 'authenticated' : 'anonymous'),
} = {}) {
  const registry = createLimiterRegistry({ limits, now });
  const middleware = (req, res, next) => {
    const cls = clientClass(req);
    const key = clientKey(req);
    const verdict = registry.bucketFor(key, cls).tryRemove(1);
    const limit = resolveLimit(limits, cls);

    res.setHeader?.('X-RateLimit-Limit', String(limit.capacity));
    res.setHeader?.('X-RateLimit-Remaining', String(verdict.remaining));

    if (verdict.allowed) {
      metrics.inc('allowed');
      return next();
    }
    metrics.inc('blocked');
    const retryAfterSec = Math.ceil(verdict.retryAfterMs / 1000);
    res.setHeader?.('Retry-After', String(retryAfterSec));
    log?.warn?.('rate_limit_exceeded', { key, class: cls, retryAfterSec });
    res.status?.(429);
    return res.json?.({ error: 'rate_limited', retryAfterSec });
  };
  middleware.metrics = metrics;
  middleware.registry = registry;
  return middleware;
}
