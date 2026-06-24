# Runbook: запуск хоста и руководство для ИИ-агента

Этот файл описывает, **как поднять исполнители конвейера** и **куда ходить ИИ-агенту** —
какие инструменты (HTTP-эндпоинты оркестратора) вызывать для каждой роли, где их искать
и почему «MCP-инструментов оркестратора» сейчас нет.

> Коротко для ИИ: **MCP-сервера у оркестратора нет.** «Инструменты оркестратора» — это
> HTTP API на `http://localhost:4186/api/...` (см. раздел «Карта инструментов»). Не ищи
> `mcp__orchestrator__*` — их не существует. Единственный подключённый MCP — `magic`
> (генерация UI-компонентов), к задачам отношения не имеет.

---

## 1. Архитектура: кто что исполняет

Источник истины — БД `orchestrator_db` (Postgres `infra-postgres-1:5432`). Задача движется
по маршруту этапов проекта (`project_stages`); каждый этап привязан к роли. Роли исполняются
**тремя разными путями**:

| Путь исполнения | Роли | Кто запускает | Где работает |
|---|---|---|---|
| **Фоновый runner внутри БД (LLM)** | `ARCHITECT`, `DECOMPOSER`, `TASK_REVIEWER`, `FAILURE_ANALYST`, `DOCUMENTATION_AUDITOR`, `DOCUMENTATION_KEEPER` | сам оркестратор (контейнер) через `roleEngine.js` → LLM-коннектор | внутри контейнера orchestrator-service |
| **Claude-мост (Разработчик)** | `PROGRAMMER` | ИИ-агент (Claude) + Scanner-фидер | на хосте / в IDE |
| **Host-runner (действия)** | `PIPELINE_SERVICE`, `GIT_INTEGRATOR` | нативный процесс `host-runner` | на хосте (нужны docker/git) |
| **Файловый мост** | `SCANNER` | `scanner-service` (наблюдение за папкой) | на хосте |

**Важно (типичная причина «задачи застряли»):** роли `PIPELINE_SERVICE`/`GIT_INTEGRATOR`
**не** исполняются внутри контейнера — им нужны docker/git. Если host-runner не запущен,
задачи бессрочно стоят в статусе `TESTING` (этап «Пайплайн и тесты» / в UI — «Тестировщик»)
и `COMMIT`. Лечится запуском host-runner (раздел 3).

Роль `TESTER` существует в каталоге ролей, но **не подключена ни к одному исполнителю**
(нет в `LLM_ROLE_CODES`, нет в `HOST_ROLES`). Если завести этап с ролью `TESTER`, задачи
на нём встанут намертво. Для прогона тестов используйте `PIPELINE_SERVICE`, а не `TESTER`.

---

## 2. Запуск оркестратора (БД-сервис)

Оркестратор поднят в Docker и слушает `:4186`:

```bash
docker compose up -d orchestrator-service     # из корня репозитория
curl -s http://localhost:4186/health          # → {"status":"ok"}
```

Проверка БД и распределения задач (read-only):

```bash
docker exec infra-postgres-1 psql -U postgres -d orchestrator_db -c \
  "SELECT COALESCE(r.code,'(none)') role, t.status, count(*) \
     FROM tasks t LEFT JOIN roles r ON r.id=t.current_role_id GROUP BY 1,2 ORDER BY 3 DESC;"
```

> Память проекта: live-контейнер `:4186` может отставать от рабочего дерева (нет hot-reload).
> Для E2E текущего кода поднимайте локально `PORT=4196 node bin/server.js` к той же БД.

---

## 3. Запуск host-runner (исполнитель `PIPELINE_SERVICE` / `GIT_INTEGRATOR`)

Нативный процесс на хосте; опрашивает оркестратор и выполняет действия там, где есть docker/git.

```bash
node host-runner/bin/host-runner.js
```

Параметры (env, со значениями по умолчанию):

| Переменная | Default | Назначение |
|---|---|---|
| `ORCHESTRATOR_URL` | `http://localhost:4186` | адрес оркестратора |
| `ORCHESTRATOR_API_TOKEN` | `` (пусто) | Bearer-токен, если включена авторизация |
| `HOST_RUNNER_INTERVAL_MS` | `3000` | период опроса очереди |
| `HOST_REPO_ROOT` | корень репозитория (`host-runner/..`) | где лежат репозитории проектов |
| `HOST_PICKER_PORT` | `4187` | локальный HTTP-мост «Выбрать папку» для UI (0 = выключить) |

Что делает: каждые 3 с дёргает `GET /api/runner/next-host-task?role=PIPELINE_SERVICE` и
`...?role=GIT_INTEGRATOR`; на `PIPELINE_SERVICE` запускает реальный прогон через
`pipeline-runner`, на `GIT_INTEGRATOR` — `git add` файлов задачи + локальный коммит; результат
сдаёт через `POST /api/runner/host-task-completed`.

Условие, что задача будет взята: проект не `paused`, у роли есть активный агент
(для не-AI ролей это локальный провайдер, напр. `local_pipeline`), и включённый этап проекта
маршрутизирует роль на текущий статус задачи (`PIPELINE_SERVICE → TESTING`, `GIT_INTEGRATOR → COMMIT`).

---

## 4. Запуск scanner-service (роль `SCANNER`, файловый мост)

Наблюдает за папкой задач проекта и переносит завершённые Claude-задачи в БД.

```bash
node scanner-service/bin/scanner-service.js
```

> Память проекта: на диске `K:` встречается глитч Docker bind-mount — scanner надёжнее
> запускать на хосте (нативно), а не в контейнере.

Для включённого этапа `SCANNER` обязателен абсолютный `scanner.watchDirectory`; существование
папки проверяет сам scanner-service (`scanner_watch_directory_unavailable` в readiness).

---

## 5. Карта инструментов оркестратора (HTTP API) — куда ходить ИИ

База: `http://localhost:4186`. Все тела — JSON.

### 5.1. Цикл роли «Разработчик» (`PROGRAMMER`) — это делает ИИ-агент

1. **Взять задачу:**
   `GET /api/runner/next-claude-task`
   → `{ task: { id, project, service, title, description, priorRoleOutputs, lastReview } }`
   (или `{ task: null }`, если очередь пуста). Назначает задачу агенту `claude_programmer`.

2. **Выполнить** реализацию в репозитории, прогнать тесты.

3. **Сдать результат:**
   `POST /api/scanner/task-completed`
   ```json
   {
     "taskId": "<uuid задачи>",
     "completionKey": "<любой уникальный ключ сдачи>",
     "project": "<код проекта, напр. PROJECT>",
     "service": "<код сервиса, напр. ORCHESTRATOR>",
     "title": "<заголовок задачи>",
     "sourceDocument": "<метка источника, напр. claude-programmer/...>",
     "result": "<отчёт Programmer: что и как сделано>",
     "changedFiles": ["path/one.js", "path/two.md"]
   }
   ```
   → `{ accepted: true, nextRole: "TASK_REVIEWER" }`. Задача уходит на ревью.
   Ревьюер отклоняет, если нет `result` и `changedFiles` — отчёт обязателен.

4. **Откатить захват** (если не смог сделать): `POST /api/runner/release-claude-task` `{ "taskId": "..." }`.

### 5.2. Host-роли (обычно дёргает host-runner, не ИИ напрямую)

- `GET  /api/runner/next-host-task?role=PIPELINE_SERVICE` — взять задачу.
- `POST /api/runner/host-task-completed` `{ taskId, roleCode, success, output }` — сдать.
- `POST /api/runner/release-host-task` `{ taskId }` — откатить.

### 5.3. LLM-роли (ARCHITECT/DECOMPOSER/TASK_REVIEWER/FAILURE_ANALYST/DOC_*)

Исполняются **автоматически** фоновым runner-ом внутри оркестратора. Вручную дёргать не нужно —
достаточно, чтобы контейнер был запущен и у ролей были активные агенты/коннекторы.

### 5.4. Конфигурация и наблюдение

| Метод | Путь | Назначение |
|---|---|---|
| GET | `/health` | проверка живости |
| GET | `/api/version` | версия сервиса + сводка применённых миграций (открыт, для healthcheck/деплоя) |
| GET | `/api/db/migrations` | список реально применённых миграций (`filename` + `appliedAt`) |
| GET | `/api/projects` | список проектов (rich) |
| POST | `/api/projects` | регистрация/upsert проекта по папке |
| GET/PUT | `/api/projects/:id/stages` | прочитать/сохранить этапы (контракт `enabled` + `scanner.watchDirectory` + `taskStatus`) |
| GET | `/api/projects/:id/task-statistics` | статистика по задачам/этапам |
| GET | `/api/roles` | каталог ролей (коды, имена, промпты, hidden) |
| GET | `/api/roles/:code/fields` | контракт полей роли (inputs/outputs) |
| GET | `/api/db/status` | статус БД |

`:id` проекта резолвится по uuid / `code` / `root_path` / `name`.

---

## 6. Где искать в коде (для ИИ, когда нужно уточнить контракт)

| Что | Файл |
|---|---|
| HTTP-маршруты оркестратора | `orchestrator-service/backend/src/server.js` |
| Захват/сдача задач, переходы | `orchestrator-service/backend/src/db.js` (`claimNextClaudeTask`, `acceptScannerCompletion`, `claimNextHostTask`, `completeHostTask`) |
| Таблица маршрута ролей / типы ролей | `orchestrator-service/backend/src/rolePipeline.js` (`ROLE_FLOW`, `ROLE_KINDS`) |
| LLM-роли и движок reasoning | `orchestrator-service/backend/src/roleEngine.js` (`LLM_ROLE_CODES`, `HOST_ROLE_CODES`) |
| Контракт этапов / папка Scanner | `orchestrator-service/backend/src/stages.js` |
| Host-исполнители (pipeline/git) | `host-runner/src/actions.js`, `host-runner/bin/host-runner.js` |
| Документация API | `docs/API_MAP.md`, `orchestrator-service/backend/docs/api-projects.md` |

---

## 7. Про MCP оркестратора (честно)

- **Сейчас MCP-сервера оркестратора нет.** В `~/.claude.json` в `mcpServers` подключён только
  `magic` (`@21st-dev/magic`) — генерация UI-компонентов. `@modelcontextprotocol/sdk` в
  `node_modules` — транзитивная зависимость, в коде проекта не используется.
- Поэтому работа с задачами идёт **через HTTP API** (разделы 5.1–5.4), а не через `mcp__*`-инструменты.
- Если в будущем понадобится MCP-обёртка над оркестратором — её нужно написать (stdio/HTTP
  MCP-сервер поверх тех же эндпоинтов `db.js`) и зарегистрировать в `.mcp.json` проекта или в
  `~/.claude.json`. До этого момента не предполагай наличие `mcp__orchestrator__*`.

---

## 8. Быстрый чек-лист «задачи не движутся»

1. `curl http://localhost:4186/health` — оркестратор жив?
2. Распределение задач по ролям (SQL из раздела 2) — на какой роли затык?
3. Затык на `CODING`/`PROGRAMMER` → нужен ИИ-агент (раздел 5.1) либо задача уже назначена
   (`assigned_agent_id` ≠ null) и ждёт фидер.
4. Затык на `TESTING`/`PIPELINE_SERVICE` или `COMMIT`/`GIT_INTEGRATOR` → **не запущен host-runner**
   (раздел 3). Проверь процессы: должен быть `node host-runner/bin/host-runner.js`.
5. Затык на роли без исполнителя (напр. `TESTER`) → ошибка конфигурации этапов: перенастрой этап
   на поддерживаемую роль.
6. Активный агент роли есть? `SELECT a.code,a.provider,a.is_active FROM agents a JOIN roles r ON r.id=a.role_id WHERE r.code='<РОЛЬ>';`
