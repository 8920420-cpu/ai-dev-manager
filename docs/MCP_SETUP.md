# Подключение MCP-сервера AI Dev Manager

`mcp-service` — рекомендуемый MCP-интерфейс AI Dev Manager. Это тонкий адаптер
MCP → HTTP поверх `tools-service` (файлы проекта) и `orchestrator-service`
(состояние и управление задачами). Прямое HTTP API сервисов по-прежнему доступно
(см. [RUNBOOK_AI_AND_HOST.md](RUNBOOK_AI_AND_HOST.md)) — MCP его не заменяет, а
оборачивает.

Исходники и полный список инструментов: [`mcp-service/README.md`](../mcp-service/README.md).

## Предусловия

MCP-сервер ничего не делает сам — он обращается к двум сервисам, которые должны
быть доступны с той машины, где запущен `mcp-service`:

- `orchestrator-service` — по умолчанию `http://localhost:4186` (в compose порт
  опубликован: `4186:80`);
- `tools-service` — по умолчанию `http://localhost:4188`. **Порт 4188 опубликован
  в `docker-compose.yml`** (`4188:4188`) специально для локального MCP-клиента.

Поднять зависимости:

```bash
docker compose up -d orchestrator-service tools-service
# (опционально) MCP в HTTP-режиме:
docker compose up -d mcp-service
curl http://localhost:4186/health
curl http://localhost:4188/health
curl http://localhost:4190/health   # если поднят mcp-service (HTTP)
```

Установить зависимости сервиса (для stdio-запуска клиентом):

```bash
cd mcp-service && npm install
```

## Про `PROJECT_ROOT`

Файловые инструменты выполняет `tools-service`, поэтому `PROJECT_ROOT`
передаётся ему как `root` и резолвится **в его окружении**:

- `tools-service` в Docker (mount `./:/app/ai-dev-manager`) → `PROJECT_ROOT=ai-dev-manager`;
- `tools-service` на хосте → `PROJECT_ROOT` = абсолютный путь к корню репозитория.

## Claude Code

Проектный файл [`.mcp.json`](../.mcp.json) уже в корне репозитория:

```json
{
  "mcpServers": {
    "ai-dev-manager": {
      "command": "node",
      "args": ["mcp-service/bin/mcp-service.js"],
      "env": {
        "PROJECT_ROOT": "ai-dev-manager",
        "ORCHESTRATOR_URL": "http://localhost:4186",
        "TOOLS_SERVICE_URL": "http://localhost:4188",
        "MCP_ENABLE_WRITE": "1",
        "MCP_ENABLE_DELETE": "1",
        "MCP_ENABLE_ORCHESTRATOR_MUTATIONS": "1"
      }
    }
  }
}
```

Claude Code подхватит сервер `ai-dev-manager` автоматически; проверить —
`/mcp` в Claude Code или `claude mcp list`.

## VS Code

Проектный файл [`.vscode/mcp.json`](../.vscode/mcp.json):

```json
{
  "servers": {
    "ai-dev-manager": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/mcp-service/bin/mcp-service.js"],
      "env": { "PROJECT_ROOT": "ai-dev-manager", "ORCHESTRATOR_URL": "http://localhost:4186", "TOOLS_SERVICE_URL": "http://localhost:4188" }
    }
  }
}
```

Откройте панель MCP в VS Code (Copilot Chat → MCP) и запустите сервер
`ai-dev-manager`.

## Codex

Codex не использует проектный `.mcp.json`; MCP-серверы задаются в глобальном
`~/.codex/config.toml`. Пример (подставьте абсолютный путь к репозиторию):

```toml
[mcp_servers.ai-dev-manager]
command = "node"
args = ["/абсолютный/путь/к/ai-dev-manager/mcp-service/bin/mcp-service.js"]

[mcp_servers.ai-dev-manager.env]
PROJECT_ROOT = "ai-dev-manager"
ORCHESTRATOR_URL = "http://localhost:4186"
TOOLS_SERVICE_URL = "http://localhost:4188"
MCP_ENABLE_WRITE = "1"
MCP_ENABLE_DELETE = "1"
MCP_ENABLE_ORCHESTRATOR_MUTATIONS = "1"
```

## HTTP/SSE-режим

Для клиентов, поддерживающих удалённый MCP по HTTP:

```bash
docker compose up -d mcp-service           # слушает :4190
# или локально:
node mcp-service/bin/mcp-service.js --http-only
```

- health: `GET http://localhost:4190/health`
- MCP (Streamable HTTP, stateless): `POST http://localhost:4190/mcp`

## Быстрая проверка инструментов

После подключения в клиенте должны быть доступны как минимум:
`project_read_file`, `project_search_text`, `orchestrator_health`,
`orchestrator_list_projects`. Write/delete/mutation-инструменты появляются только
при соответствующих флагах `MCP_ENABLE_*`.

Постановка задачи: при `MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1` доступен
`orchestrator_create_task` — заводит новую задачу под ролью «Приёмщик задач»
(`TASK_INTAKE_OFFICER`) в статусе `BACKLOG`; оркестратор сам подхватывает её
фоновым runner'ом и ведёт по цепочке (Приёмщик → Architect → …). Обязательные
поля: `externalId`, `project`, `title`; идемпотентно по `(project, externalId)`.
