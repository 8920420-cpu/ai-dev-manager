# Runbook: запуск хоста и руководство для ИИ-агента

Этот файл описывает, **как поднять исполнители конвейера** и **куда ходить ИИ-агенту** —
какие инструменты (HTTP-эндпоинты оркестратора или MCP `mcp-service`) вызывать для каждой
роли и где их искать.

> Коротко для ИИ: рекомендуемый интерфейс — **MCP-сервер `mcp-service`** (тонкий адаптер
> поверх tools-service и orchestrator-service), подключение в [MCP_SETUP.md](MCP_SETUP.md).
> Прямое HTTP API на `http://localhost:4186/api/...` (см. раздел «Карта инструментов»)
> по-прежнему доступно и эквивалентно — MCP его оборачивает, а не заменяет.

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
незахваченные задачи без `assigned_agent_id` стоят в статусе `TESTING` (этап «Пайплайн и тесты» /
в UI — «Тестировщик») и `COMMIT`. Лечится запуском host-runner (раздел 3). Если задача уже
была захвачена через `GET /api/runner/next-host-task` и host-runner умер до
`POST /api/runner/host-task-completed` или `POST /api/runner/release-host-task`, оркестратор
вернёт её в пул по `RUNNER_HOST_TIMEOUT_MS`.

Роль `TESTER` существует в каталоге ролей, но **не подключена ни к одному исполнителю**
(нет в `LLM_ROLE_CODES`, нет в `HOST_ROLES`). Если завести этап с ролью `TESTER`, задачи
на нём встанут намертво. Для прогона тестов используйте `PIPELINE_SERVICE`, а не `TESTER`.

**Важно (новый класс «задача сама ушла в BLOCKED с причиной», b56c936):** оркестратор
уводит задачу в `BLOCKED` С ВНЯТНОЙ ПРИЧИНОЙ, когда этап несколько прогонов подряд
обрывается без вердикта (`CANCELLED`/`TIMEOUT`), — вместо молчаливого блока и петли
перезапусков, жгущей токены. Это НЕ чинится автоматом — нужен **ручной перезапуск**.
- `ARCHITECT-BUDGET-LOOP-001`: `K = ARCHITECT_BUDGET_LOOP_MAX` (дефолт 3) подряд
  оборванных прогонов Архитектора на `ARCHITECTURE` → `BLOCKED`; причина в
  `data_card.architect_budget_block` и событии `TASK_BLOCKED`
  (`reason='architect_budget_exhausted'`). Обычно означает «эпик слишком крупный».
  Действие: разбить эпик на пакеты по 4–5 сервисов/фронтов и вернуть в ARCHITECTURE,
  либо увеличить бюджет Архитектора (`ARCHITECT_TASK_TIMEOUT_MS`, `ARCHITECT_MAX_TURNS`).
- `TASK-RUN-LOOP-CAP-001`: `K = TASK_RUN_LOOP_MAX` (дефолт 5) подряд оборванных
  прогонов ЛЮБОЙ роли → `BLOCKED`; причина в `data_card.auto_run_limit` и событии
  `TASK_BLOCKED` (`reason='run_budget_exhausted'`). Действие: разобрать причину (лог
  прогонов этапа, бюджет времени роли) и запустить вручную — переместить задачу на
  нужный этап (`POST /api/tasks/:id/move`).
- `PROGRAMMER-RELEASE-BACKOFF-001`: после неудачного release PROGRAMMER-прогона
  повторный claim той же `CODING`-задачи задерживается по backoff. Дефолтное расписание
  `30s → 2m → 10m` задаётся `PROGRAMMER_RELEASE_BACKOFF_MS_SCHEDULE`. После
  `PROGRAMMER_RELEASE_LOOP_MAX` (дефолт 5) подряд `FAILED`/`TIMEOUT` PROGRAMMER-прогонов
  после последнего `SUCCESS` задача без `assigned_agent_id` уходит в `BLOCKED`; событие
  `STATUS_CHANGED` содержит `reason='programmer_release_loop'` и `failedRuns`.
Найти такие задачи: `SELECT id,title,data_card->'auto_run_limit' AS run_cap,
data_card->'architect_budget_block' AS arch_budget FROM tasks WHERE status='BLOCKED'
AND (data_card ? 'auto_run_limit' OR data_card ? 'architect_budget_block');`
Для PROGRAMMER release-loop причина хранится в событии: `SELECT t.id,t.title,e.payload_json
FROM tasks t JOIN task_events e ON e.task_id=t.id WHERE t.status='BLOCKED'
AND e.event_type='STATUS_CHANGED' AND e.payload_json->>'reason'='programmer_release_loop'
ORDER BY e.created_at DESC;`

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
`pipeline-runner`, на `GIT_INTEGRATOR` — интеграция сдачи программиста в `main`; результат
сдаёт через `POST /api/runner/host-task-completed`.

Если host-runner умирает после захвата host-задачи и не успевает вызвать
`POST /api/runner/host-task-completed` или `POST /api/runner/release-host-task`, зависший
`agent_run` по ролям `PIPELINE_SERVICE`/`GIT_INTEGRATOR` переводится в `TIMEOUT` после
`RUNNER_HOST_TIMEOUT_MS` (дефолт 40 минут), у задачи очищается `assigned_agent_id` без смены
её статуса, и следующий host claim может взять её снова. В `task_events` пишется
`STATUS_CHANGED` с тем же `from_status`/`to_status` и payload `reason=host_orphan_timeout`,
`roleCode`, `hungMs`, `runStatus=TIMEOUT`.

Поведение `GIT_INTEGRATOR` (`host-runner/src/actions.js`, `runGitAction`):
- Если в контексте задачи задан `worktreeBranch` (программист сдал дельту коммитом в ветке
  `programmer/<project>/<service>` в отдельном worktree), host-runner берёт tip ветки,
  проверяет, что он содержит `deliveredCommit` (если ветка не резолвится или не содержит
  подсказку — использует `deliveredCommit`), и вливает в `main` внутри `repoRoot` весь диапазон
  `merge-base(HEAD, tip)..tip` по порядку через `git cherry-pick -x`. Многокоммитная сдача
  интегрируется полностью, а уже влитые или пустые коммиты пропускаются как
  `already_integrated`/`empty_delta`; коммит `main` существует локально даже при провале
  `push origin HEAD` (push — best-effort).
- Перед cherry-pick для путей интегрируемых коммитов выполняется
  `git status --porcelain -- <пути интегрируемых коммитов>`. Если грязные пути по blob-содержимому
  совпадают с tip интегрируемой ветки, host-runner считает их незакоммиченным дублем дельты,
  уносит в `git stash push -u` с сообщением `gi-autostash <taskId> <worktreeBranch>` и продолжает;
  после успешной интеграции autostash удаляется.
- Если грязные пути не совпадают с tip ветки, интеграция завершается `success:false` с note
  `dirty_worktree_conflict`, диагностикой `dirtyPaths`/`mismatchedPaths`, без изменения файлов и
  без создания stash.
- Если autostash создан, но cherry-pick или пустой итог интеграции завершается провалом, stash не
  удаляется; ref возвращается в диагностике как `autostash`.
- Если `worktreeBranch` не задан — прежний путь (обратная совместимость со старым
  программистом): `git add` файлов задачи (`changedFiles`) + локальный коммит.
- Пустой итог интеграции (`no_changed_files` / `nothing_to_stage`), когда изменения
  ЗАЯВЛЕНЫ (непустой `changedFiles` ИЛИ `worktreeBranch` с непустым `deliveredCommit`),
  теперь возвращается как провал (`success:false`, note `empty_deliverable_declared_changes`),
  а не тихий `success:true`: иначе конвейер «зелёный», а код не доехал. Пустой итог при реально
  пустой сдаче (нет ветки и пустой `changedFiles`) — прежний `success:true` note `no_changed_files`.

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
   Если та же задача ранее была освобождена неуспешным PROGRAMMER-прогоном, claim
   применяет cooldown по числу подряд идущих `FAILED`/`TIMEOUT` после последнего
   `SUCCESS`: по умолчанию `30s → 2m → 10m` с потолком на последнем значении
   (`PROGRAMMER_RELEASE_BACKOFF_MS_SCHEDULE`). Приоритет очереди и сериализация
   worktree по сервису сохраняются.

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
     "changedFiles": ["path/one.js", "path/two.md"],
     "worktreeBranch": "programmer/PROJECT_2/<service>",
     "deliveredCommit": "d42902dd",
     "numTurns": 42,
     "tokensIn": 12345,
     "tokensOut": 6789,
     "tokensCacheRead": 100000,
     "tokensCacheCreation": 2000,
     "costUsd": 0.1234,
     "coldStartMs": 850
   }
   ```
   Поля `tokensIn`, `tokensOut`, `tokensCacheRead`, `tokensCacheCreation`,
   `costUsd`, `coldStartMs` — **опциональные** KPI-поля сдачи, которые
   `programmer-runner` шлёт рядом с `numTurns`. Оркестратор маппит их в
   `agent_runs` (`token_input`, `token_output`, `token_cache_read`,
   `token_cache_creation`, `cost`, `cold_start_ms`) через COALESCE: старый
   раннер без этих полей не затирает данные (обратная совместимость).
   Поля `worktreeBranch`, `deliveredCommit` — **опциональные** (WORKTREE-BRANCH-CONTEXT-001):
   ветка и коммит worktree программиста (`programmer/<project>/<service>`). Нужны роли
   `GIT_INTEGRATOR`, чтобы влить ветку в `main`, а не искать незакоммиченные файлы в
   основном дереве. При отсутствии (старый раннер) пишутся как `null`, поведение прежнее.
   → `{ accepted: true, nextRole: "TASK_REVIEWER" }`. Задача уходит на ревью.
   Ревьюер отклоняет, если нет `result` и `changedFiles` — отчёт обязателен.

4. **Откатить захват** (если не смог сделать): `POST /api/runner/release-claude-task` `{ "taskId": "..." }`.
   Эндпоинт освобождает задачу и финализирует последний `RUNNING` PROGRAMMER `agent_run`:
   как `FAILED` для обычного release либо как `TIMEOUT`, если `reason=agent_timeout`.
   Эти `FAILED`/`TIMEOUT` после последнего `SUCCESS` используются для cooldown и счётчика
   подряд идущих провалов; при достижении `PROGRAMMER_RELEASE_LOOP_MAX` задача блокируется
   с `reason='programmer_release_loop'`.

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

## 7. Про MCP оркестратора

- **MCP-сервер есть** — это отдельный микросервис [`mcp-service`](../mcp-service/README.md):
  тонкий адаптер MCP → HTTP поверх `tools-service` (файлы проекта) и `orchestrator-service`
  (состояние и управление задачами). Подключение клиентов (Claude Code `.mcp.json`,
  VS Code `.vscode/mcp.json`, Codex `~/.codex/config.toml`) описано в [MCP_SETUP.md](MCP_SETUP.md).
- Инструменты называются `project_*` (файлы) и `orchestrator_*` (оркестратор) — например
  `mcp__ai-dev-manager__orchestrator_list_projects`. Read-инструменты доступны всегда;
  write/delete/мутации — только при флагах `MCP_ENABLE_WRITE` / `MCP_ENABLE_DELETE` /
  `MCP_ENABLE_ORCHESTRATOR_MUTATIONS`.
- Прямое **HTTP API** (разделы 5.1–5.4) остаётся равноправным способом работы — `mcp-service`
  лишь оборачивает те же эндпоинты, не перенося в себя бизнес-логику.
- Помимо `ai-dev-manager`, в `~/.claude.json` может быть подключён `magic` (`@21st-dev/magic`,
  генерация UI-компонентов) — к задачам отношения не имеет.

---

## 8. Быстрый чек-лист «задачи не движутся»

1. `curl http://localhost:4186/health` — оркестратор жив?
2. Распределение задач по ролям (SQL из раздела 2) — на какой роли затык?
3. Затык на `CODING`/`PROGRAMMER` → нужен ИИ-агент (раздел 5.1) либо задача уже назначена
   (`assigned_agent_id` ≠ null) и ждёт фидер.
4. Затык на `TESTING`/`PIPELINE_SERVICE` или `COMMIT`/`GIT_INTEGRATOR` без `assigned_agent_id` →
   **не запущен host-runner** (раздел 3). Проверь процессы: должен быть
   `node host-runner/bin/host-runner.js`. Если `assigned_agent_id` есть и последний
   `agent_run` остался `RUNNING`, это уже захваченная host-задача: после
   `RUNNER_HOST_TIMEOUT_MS` оркестратор переведёт прогон в `TIMEOUT`, очистит назначение и
   запишет `task_events` с `reason=host_orphan_timeout`.
5. Затык на роли без исполнителя (напр. `TESTER`) → ошибка конфигурации этапов: перенастрой этап
   на поддерживаемую роль.
6. Активный агент роли есть? `SELECT a.code,a.provider,a.is_active FROM agents a JOIN roles r ON r.id=a.role_id WHERE r.code='<РОЛЬ>';`
