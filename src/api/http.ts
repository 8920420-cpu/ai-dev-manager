/**
 * Тонкая обёртка над fetch для общения с backend оркестратора.
 * База `/api` проксируется на backend (см. vite.config.ts → server.proxy,
 * в проде — nginx/Node отдают тот же origin).
 */

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Опциональный токен API (ORCHESTRATOR_API_TOKEN на backend). */
let apiToken: string | null = null;
export function setApiToken(token: string | null): void {
  apiToken = token;
}

interface RequestOptions {
  /** Для отмены устаревших запросов (напр. при смене проекта). */
  signal?: AbortSignal;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (apiToken) headers['Authorization'] = `Bearer ${apiToken}`;

  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts?.signal,
    });
  } catch (err) {
    // Отмену пробрасываем как есть, чтобы вызывающий мог её отличить.
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
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
    throw new ApiError(msg, res.status);
  }

  return data as T;
}

export const http = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>('GET', path, undefined, opts),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};
