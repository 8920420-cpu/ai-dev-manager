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
export const API_UNAUTHORIZED_EVENT = 'adm-api-unauthorized';
export const API_TOKEN_STORAGE_KEY = 'adm.apiToken';

function readStoredApiToken(): string | null {
  try {
    return sessionStorage.getItem(API_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

let apiToken: string | null = readStoredApiToken();
let bootstrapPromise: Promise<void> | null = null;

export function setApiToken(token: string | null): void {
  const next = token && token.trim() ? token.trim() : null;
  apiToken = next;
  try {
    if (next) sessionStorage.setItem(API_TOKEN_STORAGE_KEY, next);
    else sessionStorage.removeItem(API_TOKEN_STORAGE_KEY);
  } catch {
    // sessionStorage может быть недоступен; токен всё равно работает в памяти вкладки.
  }
}
export function getApiToken(): string | null {
  return apiToken;
}

export async function ensureApiToken(): Promise<void> {
  if (apiToken) return;
  if (!bootstrapPromise) {
    bootstrapPromise = fetch('/api/client-auth')
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { token?: unknown };
        if (typeof data.token === 'string' && data.token.trim()) {
          setApiToken(data.token);
        }
      })
      .catch(() => undefined);
  }
  await bootstrapPromise;
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
  // Общие / транспорт
  unauthorized: 'Нет доступа к API оркестратора. Проверьте токен авторизации.',
  forbidden: 'Доступ запрещён.',
  not_found: 'Запрошенные данные не найдены.',
  method_not_allowed: 'Метод запроса не поддерживается.',
  invalid_json: 'Сервер получил некорректный JSON.',
  body_too_large: 'Слишком большой запрос.',
  name_required: 'Укажите название.',
  // Проекты
  project_conflict: 'Проект был изменён другим процессом. Обновите данные и повторите действие.',
  project_path_required: 'Укажите путь к папке проекта.',
  project_not_found: 'Проект не найден.',
  project_invalid_status: 'Недопустимый статус проекта.',
  project_id_required: 'Не указан идентификатор проекта.',
  // Этапы и Scanner
  stage_field_inconsistent: 'Контракты данных ролей не согласованы. Проверьте поля и порядок этапов.',
  stage_validation_failed: 'Этапы не прошли проверку. Исправьте отмеченные поля.',
  stage_role_no_executor:
    'В этапе выбрана роль без исполнителя — задача зависнет. Уберите роль или назначьте ей исполнителя.',
  scanner_watch_directory_required: 'Для Scanner нужно указать папку документов проекта.',
  scanner_watch_directory_must_be_absolute: 'Путь к папке Scanner должен быть абсолютным.',
  scanner_stage_conflict: 'В схеме найден конфликт этапа Scanner.',
  // Подключения к базам данных
  database_connection_in_use: 'Подключение к базе используется проектами и не может быть удалено.',
  database_connection_not_found: 'Подключение к базе данных не найдено.',
  database_connection_name_required: 'Укажите название подключения к базе данных.',
  database_connection_unsupported_dbms: 'Тип СУБД не поддерживается.',
  project_database_unknown: 'Выбранная база данных не найдена.',
  project_database_selection_required: 'Нужно выбрать базу данных для проекта.',
  // Интеграции / коннекторы
  unknown_provider: 'Неизвестный провайдер интеграции.',
  connector_not_found: 'Интеграция не найдена.',
  connector_name_exists: 'Интеграция с таким названием уже существует.',
  connector_disabled: 'Интеграция отключена — включите её перед использованием.',
  connector_driver_not_invocable: 'Эту интеграцию-движок (Codex / Claude Code) нельзя вызвать напрямую.',
  connector_invoke_failed: 'Не удалось выполнить запрос к интеграции.',
  prompt_required: 'Введите текст запроса (prompt).',
  no_enabled_connector: 'Нет включённого AI-коннектора для этой роли.',
  // Интеграции обращений (третий канал приёма Task Intake Officer)
  intake_integration_not_found: 'Интеграция обращений не найдена.',
  intake_integration_name_exists: 'Интеграция обращений с таким названием уже существует.',
  invalid_intake_token: 'Неверный токен интеграции обращений.',
  integration_disabled: 'Интеграция обращений выключена.',
  message_too_short: 'Сообщение обращения слишком короткое.',
  rate_limited: 'Превышен лимит обращений по интеграции. Повторите позже.',
  user_rate_limited: 'Превышен лимит обращений по пользователю. Повторите позже.',
  // Роли
  role_not_found: 'Роль не найдена.',
  role_code_required: 'Не указан код роли.',
  role_required: 'Не указана роль.',
  role_update_invalid_body: 'Некорректные данные роли.',
  role_description_too_long: 'Описание роли слишком длинное.',
  role_prompt_too_long: 'Промт роли слишком длинный.',
  role_prompt_missing: 'У роли отсутствует промт.',
  role_hidden_must_be_boolean: 'Поле «скрыта» должно быть логическим значением.',
  role_group_invalid: 'Недопустимая группа роли.',
  role_skills_must_be_array: 'Список навыков должен быть массивом.',
  role_skill_invalid_path: 'Недопустимый путь навыка.',
  role_skill_unknown: 'Неизвестный навык.',
  role_skill_duplicate: 'Навык указан повторно.',
  role_skills_too_many: 'Слишком много навыков у роли.',
  role_not_delegated_to_engine: 'Роль больше не назначена выбранному движку.',
  // Навыки (загрузка файла)
  skill_upload_invalid_body: 'Некорректные данные навыка.',
  skill_name_invalid: 'Недопустимое имя файла навыка.',
  skill_name_too_long: 'Имя файла навыка слишком длинное.',
  skill_extension_invalid: 'Недопустимое расширение файла навыка.',
  skill_content_empty: 'Содержимое навыка пусто.',
  skill_content_too_long: 'Содержимое навыка слишком большое.',
  // MCP роли
  mcp_role_invalid_body: 'Некорректные данные MCP-роли.',
  mcp_role_code_required: 'Укажите код роли.',
  mcp_role_code_invalid: 'Недопустимый код роли (латиница, цифры, . _ -; начинается с буквы).',
  mcp_role_code_exists: 'MCP-роль с таким кодом уже существует.',
  mcp_role_name_required: 'Укажите название роли.',
  mcp_role_name_too_long: 'Название роли слишком длинное.',
  mcp_role_description_too_long: 'Описание роли слишком длинное.',
  mcp_role_prompt_too_long: 'Промт роли слишком длинный.',
  mcp_role_requirements_too_long: 'Требования к роли слишком длинные.',
  mcp_role_not_found: 'MCP-роль не найдена.',
  // Группы ролей
  role_group_name_required: 'Укажите название группы ролей.',
  role_group_name_too_long: 'Название группы ролей слишком длинное.',
  role_group_sort_order_invalid: 'Недопустимый порядок сортировки группы ролей.',
  role_group_name_taken: 'Группа ролей с таким названием уже существует.',
  role_group_id_required: 'Не указан идентификатор группы ролей.',
  role_group_update_empty: 'Нет изменений для сохранения.',
  role_group_not_found: 'Группа ролей не найдена.',
  // Связка роль ↔ движок
  role_connector_invalid_role: 'Недопустимая роль для привязки движка.',
  role_connector_invalid_connector: 'Недопустимая интеграция для привязки к роли.',
  // Поля ролей
  field_invalid_body: 'Некорректные данные поля.',
  field_key_invalid: 'Недопустимый ключ поля.',
  field_name_required: 'Укажите название поля.',
  field_name_too_long: 'Название поля слишком длинное.',
  field_value_type_invalid: 'Недопустимый тип значения поля.',
  field_key_exists: 'Поле с таким ключом уже существует.',
  field_not_found: 'Поле не найдено.',
  field_unknown: 'Неизвестное поле.',
  role_fields_invalid_body: 'Некорректный набор полей роли.',
  role_field_ref_required: 'Не указана ссылка на поле роли.',
  role_field_duplicate: 'Поле роли указано повторно.',
  // Инструменты (tools)
  tool_name_required: 'Укажите название инструмента.',
  tool_kind_invalid: 'Недопустимый тип инструмента.',
  tool_capability_invalid: 'Недопустимая возможность инструмента.',
  tool_config_invalid: 'Некорректная конфигурация инструмента.',
  tool_not_found: 'Инструмент не найден.',
  tool_name_exists: 'Инструмент с таким названием уже существует.',
  tool_unknown: 'Неизвестный инструмент.',
  capability_invalid: 'Недопустимая возможность.',
  // Серверы
  server_not_found: 'Сервер не найден.',
  server_action_invalid: 'Недопустимое действие с сервером.',
  // Аудит
  audit_run_id_required: 'Не указан идентификатор запуска аудита.',
  audit_status_invalid: 'Недопустимый статус запуска аудита.',
  audit_run_not_found: 'Запуск аудита не найден.',
  // Host-роли / задачи
  unsupported_host_role: 'Эта host-роль не поддерживается.',
  taskId_required: 'Не указан идентификатор задачи.',
  task_not_found: 'Задача не найдена.',
  // Ответ человека на вопрос агента (TASK-NEEDS-INPUT-001)
  task_not_awaiting_input: 'Задача уже не ждёт ответа — вопрос сняли или задача уехала дальше.',
  question_not_found: 'Вопрос не найден.',
  question_already_answered: 'На этот вопрос уже ответили.',
  answer_required: 'Введите ответ или выберите вариант.',
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
  await ensureApiToken();
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
      if (res.status === 401 && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(API_UNAUTHORIZED_EVENT));
      }
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
