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

## Авторизация (`ORCHESTRATOR_API_TOKEN`)

Если сервисы подняты с непустым `ORCHESTRATOR_API_TOKEN` (см. `.env`), защищённые
эндпоинты `/api/*` требуют тот же Bearer-токен у MCP-клиента — иначе оркестраторные
read-инструменты (`orchestrator_list_projects`, `orchestrator_list_codebase_memory`,
`orchestrator_get_codebase_memory`, …) и мутации (`orchestrator_create_task` и др.)
вернут `401`. Публичные `orchestrator_health` и `orchestrator_version` работают без
токена и проблему НЕ показывают.

### Единый источник токена — репозиторный `.env` (MCP-TOKEN-SYNC-001)

Раньше токен приходилось дублировать в каждый конфиг клиента, и при stdio-запуске
из Codex это ломалось: env-блок `~/.codex/config.toml` **не разворачивает** форму
`${VAR}` (в отличие от Claude Code/оболочек), поэтому `ORCHESTRATOR_API_TOKEN` туда
не попадал и stdio-процесс уходил в оркестратор без Bearer → систематический `401`,
хотя контейнерный `mcp-service` тот же токен имел.

Теперь `mcp-service` на старте **добирает недостающие переменные (в т.ч. токен) из
репозиторного `.env`** — единого источника:

- файл `.env` лежит в корне репозитория (`<repo>/.env`), **gitignored** (секрет в
  git не попадает), содержит строку `ORCHESTRATOR_API_TOKEN=<значение>`;
- путь резолвится **относительно самого модуля** (`<repo>/mcp-service/src/config.js`
  → `<repo>/.env`), а не от `cwd`, — Codex запускает процесс с произвольным `cwd`;
- **приоритет всегда у окружения процесса**: если `ORCHESTRATOR_API_TOKEN` (или
  `ORCHESTRATOR_URL` и т.п.) задан в Docker/оболочке/`config.toml` — он не
  перетирается файлом; `.env` лишь заполняет то, чего в окружении нет. Поэтому
  Docker/HTTP-запуск продолжает работать как раньше, а stdio-запуск без переменной
  добирает секрет из `.env`;
- переопределить путь файла можно переменной `MCP_ENV_FILE=<абсолютный путь>`.

Итог: **при stdio-запуске (Claude Code / Codex / VS Code) env-блок клиента можно
не указывать вовсе** — токен подхватится из репозиторного `.env`. Явно задавать
`ORCHESTRATOR_API_TOKEN` в окружении клиента по-прежнему можно (оно приоритетнее),
но больше не обязательно:

- **Windows (Claude Code):** постоянная пользовательская переменная —
  `[Environment]::SetEnvironmentVariable('ORCHESTRATOR_API_TOKEN', '<токен из .env>', 'User')`,
  затем **перезапустить Claude Code** (переменная читается на старте процесса).
- **Linux/macOS:** `export ORCHESTRATOR_API_TOKEN=<токен>` в профиле шелла.

Токен должен совпадать со значением `ORCHESTRATOR_API_TOKEN` в `.env` (им подняты
сервисы). Локальная работа без токена возможна только при `ALLOW_INSECURE_LOCAL=1`
у сервисов (по умолчанию fail-closed — `/api/*` закрыт).

### Диагностика до первого вызова (`--check`, health)

Чтобы отсутствие токена не всплывало как внезапный `401` во время работы,
`mcp-service` проверяет согласованность `ORCHESTRATOR_URL` /
`ORCHESTRATOR_API_TOKEN` / `MCP_ENABLE_ORCHESTRATOR_MUTATIONS`:

- **CLI:** `node mcp-service/bin/mcp-service.js --check` — печатает диагностику и
  выходит с кодом `1`, если мутации включены, а токен пуст (и нет
  `ALLOW_INSECURE_LOCAL=1`). Значение токена **не печатается** — только булев
  признак `tokenConfigured`.
- **stdio-старт:** при несогласованности сервис пишет предупреждение в `stderr`
  ещё до приёма первого запроса (в stdio-режиме `stdout` занят протоколом).
- **HTTP health:** `GET /health` возвращает блок `orchestrator` с
  `tokenConfigured` / `mutationsEnabled` / `configOk` (без значения токена); при
  несогласованности добавляется массив `warnings`.

### Ротация токена

Токен хранится **в одном месте** — репозиторном `.env`. Ротация:

1. заменить `ORCHESTRATOR_API_TOKEN=<новое значение>` в `<repo>/.env`;
2. перезапустить сервисы, которыми токен проверяется (`docker compose up -d`
   orchestrator-service tools-service mcp-service`) и **перезапустить
   stdio-клиент** (Claude Code/Codex/VS Code читают окружение и `.env` на старте
   процесса);
3. повторный вызов после рестарта авторизуется тем же новым токеном — `401` не
   возвращается. Проверить заранее — `node mcp-service/bin/mcp-service.js --check`.

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
        "ORCHESTRATOR_API_TOKEN": "${ORCHESTRATOR_API_TOKEN:-}",
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

> **`ORCHESTRATOR_API_TOKEN` здесь указывать НЕ нужно.** Env-блок Codex не
> разворачивает `${VAR}`, поэтому раньше токен пришлось бы хардкодить (секрет в
> конфиг — плохо) — именно это давало систематический `401`. Теперь `mcp-service`
> добирает токен из репозиторного `.env` (единый источник, см. «Авторизация»).
> Если всё же задать `ORCHESTRATOR_API_TOKEN` в этом блоке явно — он приоритетнее
> `.env`. Проверить, что токен виден процессу, —
> `node /абсолютный/путь/к/ai-dev-manager/mcp-service/bin/mcp-service.js --check`.

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

Если `orchestrator_list_projects` / `orchestrator_list_codebase_memory` отвечают
`401`, а `orchestrator_health` — ОК, значит не передан `ORCHESTRATOR_API_TOKEN`
(см. «Авторизация» выше).

Постановка задачи: при `MCP_ENABLE_ORCHESTRATOR_MUTATIONS=1` доступен
`orchestrator_create_task` — заводит новую задачу под ролью «Приёмщик задач»
(`TASK_INTAKE_OFFICER`) в статусе `BACKLOG`; оркестратор сам подхватывает её
фоновым runner'ом и ведёт по цепочке (Приёмщик → Architect → …). Обязательные
поля: `externalId`, `project`, `title`; идемпотентно по `(project, externalId)`.
