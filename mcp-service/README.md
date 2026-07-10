# mcp-service

MCP-сервер AI Dev Manager — **тонкий адаптер MCP → HTTP API** поверх
[`tools-service`](../tools-service) (файловые builtin-инструменты) и
[`orchestrator-service`](../orchestrator-service) (состояние и управление задачами).

Сервис не содержит бизнес-логики: каждый MCP-инструмент проксирует вызов в HTTP
API нижележащего сервиса и возвращает нормализованный JSON-результат. Ошибка
одного вызова **не роняет процесс** — она возвращается как `isError`-результат.

## Транспорты

- **stdio** (обязательный) — для Claude Code / Codex / VS Code. В этом режиме в
  `stdout` пишется только MCP-протокол; все логи идут в `stderr`.
- **HTTP/SSE** (опциональный, порт `4190`) — Streamable HTTP MCP на `POST /mcp`
  (stateless) и health на `GET /health`. Включается флагом `--http` / `--http-only`
  или `MCP_HTTP=1`.

## Запуск

```bash
cd mcp-service
npm install
# stdio (по умолчанию)
node bin/mcp-service.js
# только HTTP (как в Docker)
node bin/mcp-service.js --http-only
# stdio + HTTP одновременно
node bin/mcp-service.js --http
npm test
```

## Конфигурация (env)

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `PROJECT_ROOT` | Корень проекта, **передаётся в tools-service как `root`** (резолвится в его окружении). | `process.cwd()` |
| `ORCHESTRATOR_URL` | Базовый URL orchestrator-service. | `http://localhost:4186` |
| `TOOLS_SERVICE_URL` | Базовый URL tools-service. | `http://localhost:4188` |
| `ORCHESTRATOR_API_TOKEN` | Bearer-токен (если сервисы закрыты токеном). | — |
| `MCP_SERVICE_PORT` | Порт HTTP-режима. | `4190` |
| `MCP_REQUEST_TIMEOUT_MS` | Таймаут HTTP-запросов. | `30000` |
| `MCP_ENABLE_WRITE` | Включить `project_edit_file` / `project_write_file`. | выкл |
| `MCP_ENABLE_DELETE` | Включить `project_delete_file`. | выкл |
| `MCP_ENABLE_ORCHESTRATOR_MUTATIONS` | Включить release/complete-инструменты оркестратора. | выкл |

> **Важно про `PROJECT_ROOT`:** файлы читает/пишет `tools-service`, а не
> `mcp-service`. Поэтому `PROJECT_ROOT` должен быть путём, который видит
> `tools-service`. При запуске `tools-service` в Docker (mount `./:/app/ai-dev-manager`)
> это `ai-dev-manager` (резолвится в `/app/ai-dev-manager`). Если `tools-service`
> запущен на хосте — укажите абсолютный путь к корню репозитория.

## Инструменты

Файловые (через tools-service):

| MCP tool | tools-service | Флаг |
|---|---|---|
| `project_list_dir` | `list_dir` | всегда |
| `project_read_file` | `read_file` | всегда |
| `project_search_text` | `search_text` | всегда |
| `project_edit_file` | `edit_file` | `MCP_ENABLE_WRITE` |
| `project_write_file` | `write_file` | `MCP_ENABLE_WRITE` |
| `project_delete_file` | `delete_file` | `MCP_ENABLE_DELETE` |

Оркестратор — read-only (всегда):

`orchestrator_health` (`GET /health`), `orchestrator_version` (`GET /api/version`),
`orchestrator_list_projects` (`GET /api/projects`),
`orchestrator_list_codebase_memory` (`GET /api/projects/:id/codebase-memory`),
`orchestrator_get_codebase_memory` (`GET /api/projects/:id/codebase-memory/:key`),
`orchestrator_get_project_stages` (этапы из `GET /api/projects/:id`),
`orchestrator_get_task_statistics` (`GET /api/projects/:id/task-statistics`),
`orchestrator_list_roles` (`GET /api/roles`),
`orchestrator_get_role_fields` (`GET /api/roles/:code/fields`),
`orchestrator_list_mcp_roles` (`GET /api/mcp-roles` — роли, доступные через MCP, с промтом и требованиями),
`orchestrator_get_mcp_role` (`GET /api/mcp-roles/:code` — карточка MCP-роли: промт и требования),
`orchestrator_db_status` (`GET /api/db/status`),
`orchestrator_claim_next_claude_task` (`GET /api/runner/next-claude-task`),
`orchestrator_claim_next_host_task` (`GET /api/runner/next-host-task?role=`).

> Выделенного `/api/projects/:id/stages` в текущем оркестраторе нет — этапы входят
> в карточку проекта `GET /api/projects/:id` (поле `stages`); инструмент берёт их оттуда.

Оркестратор — мутации (`MCP_ENABLE_ORCHESTRATOR_MUTATIONS`):

`orchestrator_create_task` (`POST /api/scanner/task-intake`) — поставить новую задачу;
создаётся под ролью «Приёмщик задач» (`TASK_INTAKE_OFFICER`) в `BACKLOG`, дальше runner
сам ведёт её по цепочке. Идемпотентно по `(project, externalId)`.
`orchestrator_release_claude_task` (`POST /api/runner/release-claude-task`),
`orchestrator_complete_scanner_task` (`POST /api/scanner/task-completed`),
`orchestrator_complete_host_task` (`POST /api/runner/host-task-completed`),
`orchestrator_release_host_task` (`POST /api/runner/release-host-task`).

## Подключение клиентов

См. [docs/MCP_SETUP.md](../docs/MCP_SETUP.md) — настройка Claude Code (`.mcp.json`),
VS Code (`.vscode/mcp.json`) и Codex (`~/.codex/config.toml`).

> **Авторизация:** если сервисы подняты с `ORCHESTRATOR_API_TOKEN`, тот же токен
> нужен MCP-клиенту — иначе оркестраторные read-инструменты и codebase-memory дают
> `401` (при этом `orchestrator_health`/`orchestrator_version` публичны и проблему
> прячут). Передавайте токен ссылкой `"ORCHESTRATOR_API_TOKEN": "${ORCHESTRATOR_API_TOKEN:-}"`
> в `.mcp.json`, а само значение — переменной окружения клиента (секрет в git не
> коммитим). Подробности и настройка под Windows — в [MCP_SETUP.md](../docs/MCP_SETUP.md).
