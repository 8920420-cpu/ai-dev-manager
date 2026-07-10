# Живой прогон DB-driven цикла задач (E2E)

Дата прогона: 2026-06-22.

Этот документ — артефакт реального сквозного прогона замкнутого цикла задач,
выполненного для проверки работы конвейера в автоматическом режиме.

## Проверенная цепочка

1. **Feeder (scanner-service)** — обнаружил пустой слот в `runtime/claude-tasks.json`,
   забрал задачу из БД (`GET /api/runner/next-claude-task`, статус `CODING`, роль
   `PROGRAMMER`) и записал её в файл со статусом «готово к работе».
2. **Programmer (Claude Code)** — выполнил задачу, создал этот файл, проставил в
   `runtime/claude-tasks.json` `result`/`changedFiles`/`completedAt` и метку
   `status: "выполнено"`.
3. **Scanner (scanner-service)** — поймал «выполнено», задиспатчил завершение в БД
   (`POST /api/scanner/task-completed`, задача → `REVIEW`) и атомарно очистил слот.
4. **Runner (orchestrator)** — продвинул авто-роли по `ROLE_FLOW`:
   `TASK_REVIEWER → PIPELINE_SERVICE → DOCUMENTATION_AUDITOR → GIT_INTEGRATOR → DONE`.

## Примечание

Авто-роли на этом этапе — детерминированные заглушки (переключают статус и пишут
`task_events`, без реального ревью/тестов/коммита). Прогон подтверждает механику
оркестрации и файлового моста, а не качество промежуточных ролей.
