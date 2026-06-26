// MCP-SERVICE-001 — регистрация MCP-инструментов (тонкий адаптер MCP → HTTP).
//
// Принципы:
//  - read-инструменты регистрируются всегда;
//  - write/delete — только при соответствующих флагах конфига;
//  - мутации оркестратора — только при enableOrchestratorMutations;
//  - ошибка одного tool call возвращается как JSON-результат (isError), процесс
//    не падает;
//  - вся бизнес-логика — в нижележащих сервисах; здесь только маршрутизация.
//
// registerTools принимает любой объект `server` с методом
// registerTool(name, def, handler) — это и реальный McpServer из SDK, и фейковый
// реестр в юнит-тестах.
import { z } from 'zod';

/** Сериализовать результат в текстовый content MCP. */
function asText(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/** Обернуть вызов: исключения и { ok:false } → JSON-результат с isError. */
async function run(fn) {
  let result;
  try {
    result = await fn();
  } catch (e) {
    return { ...asText({ ok: false, code: 'internal_error', error: e?.message || String(e) }), isError: true };
  }
  if (result && result.ok === false) {
    return { ...asText(result), isError: true };
  }
  return asText(result);
}

/**
 * Зарегистрировать инструменты на server.
 *   server               — McpServer (или фейк с registerTool)
 *   config               — из loadConfig()
 *   toolsClient          — createToolsClient()
 *   orchestratorClient   — createOrchestratorClient()
 * Возвращает список имён зарегистрированных инструментов (удобно для тестов).
 */
export function registerTools(server, { config, toolsClient, orchestratorClient }) {
  const registered = [];
  const root = config.projectRoot;

  function tool(name, def, handler) {
    server.registerTool(name, def, handler);
    registered.push(name);
  }

  // ─────────────────────────── Файловые инструменты ───────────────────────────
  // root всегда подставляется из конфигурации — клиент не выбирает корень.

  tool(
    'project_list_dir',
    {
      title: 'Список каталога проекта',
      description: 'Список содержимого каталога внутри PROJECT_ROOT (через tools-service list_dir).',
      inputSchema: { path: z.string().optional().describe('Относительный путь каталога (по умолчанию корень).') },
    },
    ({ path }) => run(() => toolsClient.execute('list_dir', { root, path: path ?? '.' })),
  );

  tool(
    'project_read_file',
    {
      title: 'Прочитать файл проекта',
      description: 'Прочитать текстовый файл внутри PROJECT_ROOT (через tools-service read_file).',
      inputSchema: {
        path: z.string().describe('Относительный путь файла.'),
        maxBytes: z.number().int().positive().optional().describe('Лимит чтения в байтах.'),
      },
    },
    ({ path, maxBytes }) => run(() => toolsClient.execute('read_file', { root, path, maxBytes })),
  );

  tool(
    'project_search_text',
    {
      title: 'Поиск по тексту проекта',
      description: 'Подстрочный поиск по файлам проекта (через tools-service search_text).',
      inputSchema: {
        query: z.string().describe('Строка поиска (без регэкспа).'),
        maxResults: z.number().int().positive().optional(),
        maxFileBytes: z.number().int().positive().optional(),
      },
    },
    ({ query, maxResults, maxFileBytes }) =>
      run(() => toolsClient.execute('search_text', { root, query, maxResults, maxFileBytes })),
  );

  if (config.enableWrite) {
    tool(
      'project_edit_file',
      {
        title: 'Точечно отредактировать файл',
        description: 'Заменить уникальный фрагмент oldText на newText (через tools-service edit_file). Требует MCP_ENABLE_WRITE=1.',
        inputSchema: {
          path: z.string(),
          oldText: z.string().describe('Уникальный фрагмент для замены.'),
          newText: z.string().describe('Новый текст.'),
        },
      },
      ({ path, oldText, newText }) =>
        run(() => toolsClient.execute('edit_file', { root, path, oldText, newText })),
    );

    tool(
      'project_write_file',
      {
        title: 'Создать/перезаписать файл',
        description: 'Создать или перезаписать файл (через tools-service write_file). Требует MCP_ENABLE_WRITE=1.',
        inputSchema: { path: z.string(), content: z.string() },
      },
      ({ path, content }) => run(() => toolsClient.execute('write_file', { root, path, content })),
    );
  }

  if (config.enableDelete) {
    tool(
      'project_delete_file',
      {
        title: 'Удалить файл проекта',
        description: 'Удалить файл (через tools-service delete_file). Требует MCP_ENABLE_DELETE=1.',
        inputSchema: { path: z.string() },
      },
      ({ path }) => run(() => toolsClient.execute('delete_file', { root, path })),
    );
  }

  // ─────────────── Read-only инструменты оркестратора (всегда) ────────────────

  tool(
    'orchestrator_health',
    { title: 'Health оркестратора', description: 'GET /health оркестратора.', inputSchema: {} },
    () => run(() => orchestratorClient.get('/health')),
  );

  tool(
    'orchestrator_version',
    { title: 'Версия оркестратора', description: 'GET /api/version (версия + миграции).', inputSchema: {} },
    () => run(() => orchestratorClient.get('/api/version')),
  );

  tool(
    'orchestrator_list_projects',
    { title: 'Список проектов', description: 'GET /api/projects (rich-список).', inputSchema: {} },
    () => run(() => orchestratorClient.get('/api/projects')),
  );

  tool(
    'orchestrator_get_project_stages',
    {
      title: 'Этапы проекта',
      description:
        'Этапы проекта. Выделенного /stages в текущем API нет — этапы входят в карточку GET /api/projects/:id (поле stages); инструмент извлекает их оттуда.',
      inputSchema: { projectId: z.string().describe('UUID / code / root_path / name проекта.') },
    },
    ({ projectId }) =>
      run(async () => {
        const r = await orchestratorClient.get(`/api/projects/${encodeURIComponent(projectId)}`);
        if (!r.ok) return r;
        return { ok: true, status: r.status, data: { projectId, stages: r.data?.stages ?? [] } };
      }),
  );

  tool(
    'orchestrator_get_task_statistics',
    {
      title: 'Статистика задач проекта',
      description: 'GET /api/projects/:id/task-statistics.',
      inputSchema: {
        projectId: z.string(),
        limit: z.number().int().positive().optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    ({ projectId, limit, offset }) =>
      run(() =>
        orchestratorClient.get(`/api/projects/${encodeURIComponent(projectId)}/task-statistics`, {
          query: { limit, offset },
        }),
      ),
  );

  tool(
    'orchestrator_list_roles',
    { title: 'Список ролей', description: 'GET /api/roles.', inputSchema: {} },
    () => run(() => orchestratorClient.get('/api/roles')),
  );

  tool(
    'orchestrator_get_role_fields',
    {
      title: 'Поля роли',
      description: 'GET /api/roles/:code/fields.',
      inputSchema: { roleCode: z.string().describe('Код роли, например PROGRAMMER.') },
    },
    ({ roleCode }) => run(() => orchestratorClient.get(`/api/roles/${encodeURIComponent(roleCode)}/fields`)),
  );

  tool(
    'orchestrator_db_status',
    { title: 'Статус БД', description: 'GET /api/db/status.', inputSchema: {} },
    () => run(() => orchestratorClient.get('/api/db/status')),
  );

  // ─────────────── Управление задачами: захват (всегда) ───────────────
  // Захват следующей задачи доступен без mutation-флага (как чтение очереди);
  // release/complete — мутации, закрыты флагом.

  tool(
    'orchestrator_claim_next_claude_task',
    {
      title: 'Взять следующую задачу Claude',
      description: 'GET /api/runner/next-claude-task — захватить следующую задачу для Claude-исполнителя.',
      inputSchema: {},
    },
    () => run(() => orchestratorClient.get('/api/runner/next-claude-task')),
  );

  tool(
    'orchestrator_claim_next_host_task',
    {
      title: 'Взять следующую host-задачу',
      description: 'GET /api/runner/next-host-task?role=... — захватить задачу для host-роли.',
      inputSchema: { role: z.string().describe('Код host-роли, например PIPELINE_SERVICE.') },
    },
    ({ role }) => run(() => orchestratorClient.get('/api/runner/next-host-task', { query: { role } })),
  );

  // ─────────────── Мутации оркестратора (только по флагу) ───────────────

  if (config.enableOrchestratorMutations) {
    tool(
      'orchestrator_create_task',
      {
        title: 'Поставить задачу',
        description:
          'Завести новую задачу. Она создаётся под ролью «Приёмщик задач» (TASK_INTAKE_OFFICER) ' +
          'в статусе BACKLOG; дальше оркестратор сам ведёт её по цепочке (Приёмщик → Architect → …). ' +
          'POST /api/scanner/task-intake. Идемпотентно по (project, externalId): повторный вызов ' +
          'вернёт duplicate, дубль не создаётся. Требует MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1.',
        inputSchema: {
          externalId: z.string().describe('Уникальный ключ задачи в проекте (идемпотентность по project+externalId).'),
          project: z.string().describe('Проект: code / name / root_path (должен быть зарегистрирован).'),
          title: z.string().describe('Заголовок задачи.'),
          service: z.string().optional().describe('Код сервиса (авто-регистрируется; можно пусто).'),
          description: z.string().optional().describe('Исходный запрос пользователя — его прочитает Приёмщик.'),
          result: z.string().optional(),
          changedFiles: z.array(z.string()).optional(),
        },
      },
      (args) => run(() => orchestratorClient.post('/api/scanner/task-intake', args)),
    );

    tool(
      'orchestrator_release_claude_task',
      {
        title: 'Вернуть задачу Claude',
        description: 'POST /api/runner/release-claude-task — откатить захват. Требует MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1.',
        inputSchema: { taskId: z.string() },
      },
      ({ taskId }) => run(() => orchestratorClient.post('/api/runner/release-claude-task', { taskId })),
    );

    tool(
      'orchestrator_complete_scanner_task',
      {
        title: 'Завершить задачу (scanner)',
        description: 'POST /api/scanner/task-completed — сдать результат задачи. Требует MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1.',
        inputSchema: {
          taskId: z.string(),
          completionKey: z.string().optional(),
          project: z.string().optional(),
          service: z.string().optional(),
          title: z.string().optional(),
          sourceDocument: z.string().optional(),
          result: z.any().optional(),
          changedFiles: z.array(z.string()).optional(),
        },
      },
      (args) => run(() => orchestratorClient.post('/api/scanner/task-completed', args)),
    );

    tool(
      'orchestrator_complete_host_task',
      {
        title: 'Завершить host-задачу',
        description: 'POST /api/runner/host-task-completed — сдать результат host-роли. Требует MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1.',
        inputSchema: {
          taskId: z.string(),
          roleCode: z.string(),
          success: z.boolean().optional(),
          output: z.any().optional(),
        },
      },
      (args) => run(() => orchestratorClient.post('/api/runner/host-task-completed', args)),
    );

    tool(
      'orchestrator_release_host_task',
      {
        title: 'Вернуть host-задачу',
        description: 'POST /api/runner/release-host-task — откатить захват host-задачи. Требует MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1.',
        inputSchema: { taskId: z.string() },
      },
      ({ taskId }) => run(() => orchestratorClient.post('/api/runner/release-host-task', { taskId })),
    );
  }

  return registered;
}
