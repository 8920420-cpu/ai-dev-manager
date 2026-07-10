# tester-service

Микросервис роли **Pipeline Service** из [roles/tester.md](../roles/tester.md).

Технический исполнитель проверки задачи. Сервис **запускает Pipeline Runner и
возвращает результат оркестратору**. Он:

- **не** анализирует код;
- **не** анализирует ошибки;
- **не** принимает архитектурных решений;
- **не** исправляет проблемы и не даёт рекомендаций;
- **не** пропускает этапы Pipeline.

Поля `summary` / `logPath` в ответе при ошибке — это сырые артефакты для
следующей роли (**Failure Analyst**), а не разбор причин.

## Алгоритм

1. Проверить наличие `.pipeline.json`.
2. Запустить [Pipeline Runner](../pipeline-runner).
3. Дождаться завершения всех этапов.
4. Получить статус, `summary.json`, `pipeline.log`.
5. Сохранить результаты выполнения (`<projectPath>/.tmp/tester-results/<taskId>.json`).
6. Вернуть результат оркестратору.

## Входные данные

```json
{
  "taskId": "TASK-123",
  "projectPath": "/path/to/project",
  "pipelineConfigPath": "/path/to/project/.pipeline.json",
  "changedFiles": ["src/a.js"],
  "programmerComment": "реализовал расчёт цены"
}
```

`pipelineConfigPath` опционален — по умолчанию `<projectPath>/.pipeline.json`.
`changedFiles` и `programmerComment` только прокидываются в запись результата
(для аудита и следующих ролей), сервис их не интерпретирует.

## Ответ

**Успех:**

```json
{ "status": "success", "nextRole": "Documentation Auditor", "taskId": "TASK-123",
  "runId": "...", "summaryPath": "...", "logPath": "...", "resultPath": "..." }
```

**Ошибка этапа:**

```json
{ "status": "failed", "nextRole": "Failure Analyst", "taskId": "TASK-123",
  "runId": "...", "summary": "...", "summaryPath": "...", "logPath": "...",
  "failedStage": "build", "resultPath": "..." }
```

**Сбой предусловия** (нет `.pipeline.json` или Runner упал до этапов):

```json
{ "status": "error", "reason": "pipeline_config_not_found", "message": "..." }
```

## Запуск

```bash
cd tester-service
npm install        # подтянет pipeline-runner (file:../pipeline-runner)
npm start          # HTTP-сервер на $TESTER_PORT (по умолчанию 4187)
npm test           # юнит-тесты (node --test)
```

### HTTP API

| Метод | Путь | Описание |
|-------|------|----------|
| `GET` | `/health` | проверка живости |
| `POST` | `/test` | запустить проверку задачи (тело = входные данные) |
| `GET` | `/results/:taskId?projectPath=...` | сохранённый результат |

```bash
curl -X POST http://localhost:4187/test \
  -H 'Content-Type: application/json' \
  -d '{"taskId":"TASK-1","projectPath":"/abs/path/to/project"}'
```

### CLI-режим (одна проверка)

```bash
node bin/tester-service.js --check input.json
# код возврата: 0 success | 1 failed | 2 error
```
