# Контракт Pipeline runner (orchestrator-service ↔ pipeline-runner)

PIPELINE-NON-AI-EXECUTOR-001 (ORCHESTRATOR-P1.3). `PIPELINE_SERVICE` — host/
не-AI роль: оркестратор передаёт этап напрямую pipeline-runner/host worker, **не
создавая LLM-обмен и не выбирая AI-коннектор**. Исполнитель роли — локальный
агент (`provider='local'`, `local_pipeline`), а не LLM-агент. Этот контракт
фиксирует claim/result DTO для PIPELINE_RUNNER-P1.2 и INTEGRATION-P2.4.

---

## `GET /api/runner/next-host-task?role=PIPELINE_SERVICE`

Захватывает следующую задачу в статусе `TESTING` под ролью `PIPELINE_SERVICE`
(скрытая роль не выдаётся). Возвращает `{ "task": null }`, если нечего брать.

```json
{
  "task": {
    "id": "task-uuid",
    "role": "PIPELINE_SERVICE",
    "title": "…",
    "description": "…",
    "projectId": "project-uuid",
    "project": "PS",
    "serviceId": "service-uuid",
    "service": "Catalog_Service",
    "serviceName": "Catalog Service",
    "projectRoot": "PS",
    "repositoryPath": "services/catalog",
    "changedFiles": ["…"],
    "programmerResult": "…",
    "agentRunId": "run-uuid",
    "pipeline": {
      "projectId": "project-uuid",
      "projectCode": "PS",
      "serviceId": "service-uuid",
      "serviceCode": "Catalog_Service",
      "serviceName": "Catalog Service",
      "projectRoot": "PS",
      "repositoryPath": "services/catalog",
      "workingDirectory": "PS/services/catalog",
      "pipelineConfigRef": "PS/services/catalog/.pipeline.json"
    }
  }
}
```

Поле `pipeline` присутствует только для `PIPELINE_SERVICE`. Runner обязан:

- выполнять pipeline **именно** `pipeline.serviceId` в `pipeline.workingDirectory`;
- не определять сервис по свободному тексту/prompt/CWD; сверять `serviceId` и путь;
- не запускать pipeline соседнего микросервиса и не выходить за `projectRoot`.

**Ошибки до запуска команд** (HTTP 422, поле `code`): `pipeline_service_required`
(неизвестный/удалённый сервис), `pipeline_service_path_escape` (путь выходит за
корень), `pipeline_working_directory_unresolved` (нет корня проекта),
`pipeline_project_required`. При ошибке задача не выдаётся (claim откатывается).

## `POST /api/runner/host-task-completed`

Возврат структурированного результата. AI не участвует — переход
детерминирован по `success`.

```json
{
  "taskId": "task-uuid",
  "roleCode": "PIPELINE_SERVICE",
  "success": true,
  "output": {
    "summary": { "actions": [ { "name": "test", "exitCode": 0, "durationMs": 1234 } ] },
    "failedStage": null,
    "startedAt": "2026-06-22T13:00:00Z",
    "logPath": "…"
  }
}
```

При провале `PIPELINE_SERVICE` runner возвращает `success:false`,
`output.failedStage`, `output.startedAt`, `output.logPath` и
`output.summary.error` с `code`, `message`, `logTail`. `logTail` — безопасно
усечённый хвост stdout/stderr упавшей команды; `logPath` остаётся путём на хосте
и не требуется для чтения причины провала оркестратором, UI или Failure Analyst.

Переход (детерминированный, без интерпретации моделью):

- `success: true` → статус `COMMIT`, следующая роль `DOCUMENTATION_AUDITOR`
  (скрытые/следующие роли далее разрешает фоновый runner);
- `success: false` → статус `FAILURE_ANALYSIS`, роль `FAILURE_ANALYST`.

Результат сохраняется в `pipeline_runs` (`status`, `failed_stage`, `summary_json`,
`log_path`) и в `task_events`. `prompt_exchanges` для этапа не создаётся.

## `POST /api/runner/release-host-task`

`{ "taskId": "…" }` — откат захвата, если runner не смог выполнить этап.
Возвращает `{ "released": true|false, "taskId": "…" }`, помечает agent_run
`CANCELLED`.
