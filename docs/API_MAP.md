# API_MAP.md

> Карта API компонентов оркестратора. HTTP endpoints, CLI и контракты.

## Авторизация

Все `/api/*` оркестратора защищены токеном, если задан `ORCHESTRATOR_API_TOKEN`
(пусто = выключено, только локальная разработка). Открыты без токена только
`GET /health` и `GET /api/version`. Передавайте токен заголовком
`Authorization: Bearer <token>` (или `x-api-token: <token>`); для SSE
`GET /api/tasks/events` допускается `?token=<token>`. Сервисы (scanner, mcp,
tools) шлют тот же токен из своего `ORCHESTRATOR_API_TOKEN`.

В сетевом развёртывании токен обязателен: без него опубликованные HTTP-порты
дают доступ к мутациям БД, файловым инструментам tools-service и MCP.

## Scanner bridge

Scanner следит за «папкой задач» проекта (`projects.tasks_path`, с откатом на
`docs_path`); приём включается тумблером `scanner_enabled` на карточке проекта.
Конфигурация watcher'ов берётся из `GET /api/projects` (режим `SCANNER_API_BASE`).
Параллельно работает интейк Markdown-очередей (`SCANNER_INTAKE_*`): импорт задач
из `tasks/<service>.md` (секции с маркером `[x]`) в БД.

Исходящие HTTP-запросы scanner ограничены таймаутом `SCANNER_REQUEST_TIMEOUT_MS`
(по умолчанию 10000 мс), чтобы зависший оркестратор не блокировал реконфигурацию
и доставку задач навсегда.

### `POST /api/scanner/task-completed`

Scanner вызывает endpoint после появления завершённой задачи в наблюдаемом
документе папки задач проекта (`tasks_path`).

```json
{
  "completionKey": "6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7",
  "taskId": "6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7",
  "project": "PS",
  "service": "Chat_Service",
  "title": "Исправить reconnect",
  "result": "Исправлено",
  "changedFiles": ["src/chat.js"],
  "sourceDocument": "/workspace/<service>.md",
  "nextRole": "TASK_REVIEWER"
}
```

Успех: `{"accepted":true,"duplicate":false,"nextRole":"TASK_REVIEWER"}`.
Повторная доставка возвращает `duplicate:true` и не создаёт второй переход.

### `POST /api/scanner/task-intake`

Интейк (SCANNER-INTAKE-001) импортирует задачи из Markdown-очередей
`tasks/<service>.md` (секции с маркером `[x]`) в БД проекта-владельца
(`SCANNER_INTAKE_PROJECT` — `code|name|root_path`). После импорта секция
вырезается из файла-очереди.

---

## Приём обращений из приложений (INTAKE-INTEGRATIONS-001)

Третий канал приёма роли Task Intake Officer: конечные пользователи продуктов
сообщают о проблемах изнутри приложений. Обращение попадает беспроектной задачей
сразу в `BACKLOG` под Приёмщиком (не «Неразобранные»), проект определяет сам
Приёмщик по каталогу проектов.

### `POST /api/intake/report`

Открытый endpoint (мимо `ORCHESTRATOR_API_TOKEN`) — авторизация по **токену
интеграции**: заголовок `Authorization: Bearer <token>`, либо `X-Intake-Token`,
либо поле `token` в теле. Приём валидирует токен, анти-спам и идемпотентность.

Поля тела: `message` (текст обращения), `user`, `service` (микросервис-источник),
`form` (экран/форма), `externalId` (идемпотентность источника), `category`
(необязательно; `bug|idea|feature|question` — невалидное/пустое → `null`, приём не
роняет; сохраняется в `data_card.category` и в payload события `TASK_CREATED` как
подсказка пользователя, которую Приёмщик перепроверяет), `autocontext`
(URL, версия сборки, user-agent, timestamp, последние JS-ошибки, id упавшего
запроса), `screenshotUrl` (ссылка на объект в MinIO — сохраняется в карточке
задачи и доступна следующим ролям).

- **Успех:** `{"accepted":true,"duplicate":false,"imported":true,"taskId":"...",
  "reportNumber":42,"externalId":"...","nextRole":"TASK_INTAKE_OFFICER",
  "toStatus":"BACKLOG"}`. `reportNumber` — человекочитаемый номер обращения
  (последовательность `intake_report_seq`); приложение показывает «Заявка №X принята».
- **Идемпотентность:** повторная доставка того же `externalId` возвращает
  `{"accepted":true,"duplicate":true,"imported":false,"taskId":"...",
  "reportNumber":42,...}` и не создаёт дубль.
- **Ошибки:** `401 invalid_intake_token`, `403 integration_disabled`,
  `422 message_too_short`, `429 rate_limited` (по интеграции) /
  `429 user_rate_limited` (по пользователю).

### Реестр интеграций (под `ORCHESTRATOR_API_TOKEN`)

Раздел «Интеграции обращений» в карточке роли Task Intake Officer. Не путать с
«Движком» роли (`/api/integrations` — коннекторы-движки): это разные сущности.
Токен интеграции хранится только как SHA-256; наружу отдаётся флаг `has_token`.

- **`GET /api/intake-integrations`** — список: `{"integrations":[...]}`.
- **`POST /api/intake-integrations`** — создание (`201`).
- **`GET /api/intake-integrations/stats`** — статистика принятых обращений по
  интеграциям-источникам.
- **`GET /api/intake-integrations/:id`** — одна интеграция.
- **`PUT /api/intake-integrations/:id`** — обновление (включена/выключена,
  rate-limit, min-длина).
- **`DELETE /api/intake-integrations/:id`** — удаление.
- **`POST /api/intake-integrations/:id/rotate-token`** — перевыпуск токена.

### Виджет «Обратная связь» оркестратора (frontend, ORCH-FEEDBACK-WIDGET-001)

Same-origin контракт SPA-виджета «Обратная связь» (`src/api/feedbackApi.ts`,
`src/types/feedback.ts`). Виджет не шлёт токен интеграции из браузера — backend
оркестратора серверно подставляет токен предзарегистрированной интеграции
«orchestrator-ui» и переиспользует приём `acceptIntakeReport`, создавая задачу
сразу в `BACKLOG` под Приёмщиком.

Backend реализован (FEEDBACK-WIDGET-001):
`orchestrator-service/backend/src/feedback.js` (`acceptFeedback`,
`saveScreenshot`, `readScreenshot`) + роуты в `server.js` (`/api/feedback`,
`matchFeedbackScreenshotRoute`). Имя интеграции — `orchestrator-ui`
(`UI_INTEGRATION_NAME`), создаётся лениво при первом обращении (`enabled=true`);
токен подставляет сервер (в бандл фронтенда не попадает).

- **`POST /api/feedback`** — приём обращения same-origin. Тело
  (`FeedbackPayload`): `externalId` (uuid, генерирует виджет), `message`, `user`
  (имя из localStorage, дефолт `orchestrator-ui`), `category`
  (`bug|idea|feature|question`), `service` (всегда `orchestrator-ui`), `form`
  (текущий маршрут SPA), `autocontext` (`url`, `buildVersion`, `userAgent`,
  `timestamp`, `jsErrors[]`, `lastFailedApiRequestId`), `screenshotUrl?`. Ответ
  (`FeedbackResult`, переиспользует контракт `acceptIntakeReport`):
  `{ reportNumber, accepted?, duplicate?, taskId?, externalId? }`; виджет
  показывает «Заявка №N принята».
- **`POST /api/feedback/screenshot`** — загрузка скриншота. Тело `{ image }`
  (data URL растрового формата: png/jpeg/webp/gif; снимается `html2canvas`
  ленивым импортом). Размер тела ограничен `FEEDBACK_SCREENSHOT_BODY_LIMIT`
  (по умолчанию 8 МБ), декодированного изображения — `FEEDBACK_SCREENSHOT_MAX_BYTES`
  (по умолчанию 5 МБ). Ответ: `{ id, url }`, где `url` =
  `/api/feedback/screenshot/<id>.<ext>` — кладётся в `screenshotUrl` обращения.
- **`GET /api/feedback/screenshot/:id`** — отдача сохранённого скриншота
  (`id` — hex, опционально с расширением `<hex>.<ext>`); возвращает файл с
  соответствующим `Content-Type`, при отсутствии — `404 { error: 'not_found' }`.

---

## tester-service (HTTP, по умолчанию :4187)

### `GET /health`
Проверка живости.
- **Ответ:** `200 OK`.

### `POST /test`
Запустить проверку задачи (Pipeline Runner).
- **Запрос:**
```json
{
  "taskId": "TASK-123",
  "projectPath": "/abs/path/to/project",
  "pipelineConfigPath": "/abs/.../.pipeline.json",
  "changedFiles": ["src/a.js"],
  "programmerComment": "реализовал расчёт цены"
}
```
`pipelineConfigPath` опционален (по умолчанию `<projectPath>/.pipeline.json`).
`changedFiles` и `programmerComment` — только для аудита, не интерпретируются.

- **Успех:**
```json
{ "status": "success", "nextRole": "Documentation Auditor", "taskId": "TASK-123",
  "runId": "...", "summaryPath": "...", "logPath": "...", "resultPath": "..." }
```
- **Ошибка этапа:**
```json
{ "status": "failed", "nextRole": "Failure Analyst", "taskId": "TASK-123",
  "runId": "...", "summary": "...", "summaryPath": "...", "logPath": "...",
  "failedStage": "build", "resultPath": "..." }
```
- **Сбой предусловия:**
```json
{ "status": "error", "reason": "pipeline_config_not_found", "message": "..." }
```

### `GET /results/:taskId?projectPath=...`
Сохранённый результат проверки задачи.

### CLI
```bash
node bin/tester-service.js --check input.json
# код возврата: 0 success | 1 failed | 2 error
```

---

## pipeline-runner (CLI / библиотека)

### CLI
```bash
node bin/pipeline-runner.js --config .pipeline.json
```
- **stdout:** финальный JSON-результат.
- **stderr:** ход выполнения (дублируется в `pipeline.log`).
- **Код возврата:** `0` успех, `1` упал этап, `2` ошибка конфига/запуска.

### Результат
```json
{ "success": true,  "runId": "2026-06-21T14-22-15", "reportPath": ".tmp/pipeline-results/..." }
{ "success": false, "failedStage": "build", "runId": "...", "reportPath": "..." }
```

### Библиотека
```js
import { runPipeline } from './src/index.js';
const result = await runPipeline({ configPath: '.pipeline.json' });
```

### Контракт `.pipeline.json`
```json
{
  "name": "Catalog_Service",
  "workingDirectory": ".",
  "timeoutMinutes": 30,
  "stages": {
    "test":   ["go test ./..."],
    "build":  ["docker compose build"],
    "deploy": ["docker compose up -d"],
    "smoke":  ["curl -f http://localhost:8080/health"]
  }
}
```
Порядок ключей `stages` = порядок выполнения. Первая упавшая команда
останавливает весь pipeline.

### Сервисный режим по конвенции (`runServicePipeline`)
Исполнитель этапа PIPELINE_SERVICE (`runServicePipeline`/`ServicePipelineTask`,
вызывается host-runner по claim `task.pipeline`) НЕ требует `.pipeline.json` на
диске. Если у выбранного сервиса нет локального `.pipeline.json`, стадии строит
`ConventionConfigBuilder` по пути сервиса и корню проекта:
- **test** — `go.mod` → `go test ./...`; `package.json` с непустым скриптом
  `test` → `npm test`; иначе стадия SKIPPED (`no_tests_detected`);
- **build** — ближайший вверх `docker-compose.yml`/`compose.yml` (в пределах
  `projectRoot`) → `docker compose -f <compose> build`;
- **deploy** — тот же compose → `docker compose -f <compose> up -d`; если compose
  не найден — ошибка стадии `deploy` (`pipeline_compose_not_found`);
- **smoke** — есть healthcheck в compose → `docker compose -f <compose> up -d
  --wait`; иначе стадия SKIPPED (`no_healthcheck_in_compose`).

Локальный `.pipeline.json` при наличии ПЕРЕОПРЕДЕЛЯЕТ конвенцию: целиком (по
умолчанию) либо постадийно при `"extendsConvention": true` (одноимённые стадии
заменяются, новые добавляются). Изоляция прежняя: `workingDirectory`, найденный
compose и команды не выходят за `projectRoot` (`resolveServicePaths`).

Примечание: это отдельный путь от `POST /test` tester-service и CLI
`pipeline-runner --config` — там `.pipeline.json`/`pipelineConfigPath` по-прежнему
обязателен (иначе `pipeline_config_not_found`), конвенционного построения нет.

---

## orchestrator-db — ключевые запросы (контракт доступа)

Захват задачи (конкурентно-безопасно):
```sql
SELECT * FROM tasks
WHERE status = 'READY'
ORDER BY priority DESC, created_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

Захват сервиса под изменение:
```sql
INSERT INTO service_locks(service_id, task_id, locked_by_agent, lock_reason, expires_at)
VALUES (:service, :task, :agent, 'coding', now() + interval '30 min');
```

Полный перечень таблиц — [DATABASE_MAP.md](DATABASE_MAP.md).

---

## События (event_type) — внутренняя «шина» через task_events

`TASK_CREATED`, `STATUS_CHANGED`, `ROLE_ASSIGNED`, `AGENT_STARTED`,
`AGENT_FINISHED`, `PIPELINE_STARTED`, `PIPELINE_FAILED`, `PIPELINE_SUCCEEDED`,
`REVIEW_APPROVED`, `REVIEW_REJECTED`, `SERVICE_LOCKED`, `SERVICE_UNLOCKED`,
`DEPLOY_COMPLETED`, `DEPLOY_FAILED`, `TASK_DONE`, `TASK_CANCELLED`.
