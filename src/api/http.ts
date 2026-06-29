/**
 * Тонкая обёртка над fetch для общения с backend оркестратора.
 * База `/api` проксируется на backend (см. vite.config.ts → server.proxy,
 * в проде — nginx/Node отдают тот же origin).
 */

export class ApiError extends Error {
  status: number;
  /** Распарсенное тело ответа об ошибке (для структурированных кодов/деталей). */
  body: unknown;
  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Опциональный токен API (ORCHESTRATOR_API_TOKEN на backend). */
let apiToken: string | null = null;
export function setApiToken(token: string | null): void {
  apiToken = token;
}
export function getApiToken(): string | null {
  return apiToken;
}

interface RequestOptions {
  /** Для отмены устаревших запросов (напр. при смене проекта). */
  signal?: AbortSignal;
  /** Таймаут запроса в мс. По умолчанию DEFAULT_TIMEOUT_MS; 0 — без таймаута. */
  timeoutMs?: number;
}

/** Дефолтный таймаут: подвисший backend не должен вешать модалки/поллинг навсегда. */
const DEFAULT_TIMEOUT_MS = 30000;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  // Совмещаем таймаут с возможным внешним signal: оба могут оборвать запрос.
  const controller = new AbortController();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onExternalAbort = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // Внешнюю отмену пробрасываем как есть; обрыв по таймауту — как ApiError.
        if (opts?.signal?.aborted) throw err;
        throw new ApiError('Превышено время ожидания ответа сервера оркестратора', 0);
      }
      throw new ApiError('Не удалось связаться с сервером оркестратора', 0);
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: text };
      }
    }

    if (!res.ok) {
      const msg =
        (data as { error?: string; message?: string } | undefined)?.error ||
        (data as { message?: string } | undefined)?.message ||
        `Ошибка сервера (${res.status})`;
      throw new ApiError(msg, res.status, data);
    }

    return data as T;
  } finally {
    if (timer) clearTimeout(timer);
    if (opts?.signal) opts.signal.removeEventListener('abort', onExternalAbort);
  }
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('POST', path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PUT', path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>('PATCH', path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>('DELETE', path, undefined, opts),
};
