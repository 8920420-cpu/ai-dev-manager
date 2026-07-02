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

const ERROR_MESSAGES: Record<string, string> = {
  unauthorized: 'Нет доступа к API оркестратора. Проверьте токен авторизации.',
  forbidden: 'Доступ запрещён.',
  not_found: 'Запрошенные данные не найдены.',
  method_not_allowed: 'Метод запроса не поддерживается.',
  invalid_json: 'Сервер получил некорректный JSON.',
  body_too_large: 'Слишком большой запрос.',
  project_conflict: 'Проект был изменён другим процессом. Обновите данные и повторите действие.',
  stage_field_inconsistent: 'Контракты данных ролей не согласованы. Проверьте поля и порядок этапов.',
  stage_validation_failed: 'Этапы не прошли проверку. Исправьте отмеченные поля.',
  scanner_watch_directory_required: 'Для Scanner нужно указать папку документов проекта.',
  scanner_watch_directory_must_be_absolute: 'Путь к папке Scanner должен быть абсолютным.',
  scanner_stage_conflict: 'В схеме найден конфликт этапа Scanner.',
  database_connection_in_use: 'Подключение к базе используется проектами и не может быть удалено.',
  no_enabled_connector: 'Нет включённого AI-коннектора для этой роли.',
  unsupported_host_role: 'Эта host-роль не поддерживается.',
  taskId_required: 'Не указан идентификатор задачи.',
  task_not_found: 'Задача не найдена.',
  role_not_delegated_to_engine: 'Роль больше не назначена выбранному движку.',
};

function humanizeErrorMessage(message: string, status: number): string {
  const raw = String(message || '').trim();
  if (ERROR_MESSAGES[raw]) return ERROR_MESSAGES[raw];
  const prefix = raw.split(':', 1)[0]?.trim();
  if (prefix && ERROR_MESSAGES[prefix]) {
    const detail = raw.slice(prefix.length).replace(/^:\s*/, '').trim();
    return detail ? `${ERROR_MESSAGES[prefix]} Детали: ${detail}` : ERROR_MESSAGES[prefix];
  }
  if (/^[a-z][a-z0-9_]*(?::\s*.*)?$/i.test(raw)) {
    return `Ошибка сервера (${status || 'без HTTP-статуса'}): ${raw}`;
  }
  return raw || `Ошибка сервера (${status})`;
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
      throw new ApiError(humanizeErrorMessage(msg, res.status), res.status, data);
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
