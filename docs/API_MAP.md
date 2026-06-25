# API_MAP.md

> Карта API компонентов оркестратора. HTTP endpoints, CLI и контракты.

## Scanner bridge

### `POST /api/scanner/task-completed`

Scanner вызывает endpoint после появления `status: "выполнено"` в
`tasks/claude-tasks.json`.

```json
{
  "completionKey": "6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7",
  "taskId": "6f83f7aa-5033-48d9-ac7f-3cd90b31cdf7",
  "project": "PS",
  "service": "Chat_Service",
  "title": "Исправить reconnect",
  "result": "Исправлено",
  "changedFiles": ["src/chat.js"],
  "sourceDocument": "/workspace/claude-tasks.json",
  "nextRole": "TASK_REVIEWER"
}
```

Успех: `{"accepted":true,"duplicate":false,"nextRole":"TASK_REVIEWER"}`.
Повторная доставка возвращает `duplicate:true` и не создаёт второй переход.

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
