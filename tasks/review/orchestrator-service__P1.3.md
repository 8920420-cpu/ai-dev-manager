---
id: ORCHESTRATOR-P1.3
status: review
service: ORCHESTRATOR
priority: P1
initiative: PIPELINE-NON-AI-EXECUTOR-001
owner: orchestrator-service
depends_on: ["согласованный payload claim/result с `tasks/pipeline-runner.md` → P1.2; общий контракт фиксирует orchestrator-service"]
---

# P1.3 PIPELINE-NON-AI-EXECUTOR-001 — передавать Pipeline напрямую сервисному исполнителю

## Description

Передавать Pipeline напрямую сервисному исполнителю.

## Scope

- backend-диспетчер ролей/host claims, переходы и события Pipeline, seed/preset роли и соответствующие backend-тесты; без изменений `pipeline-runner/`.

## Pre-coding brief (готовит оркестратор)

- `PIPELINE_SERVICE` является host-ролью, не LLM-ролью; payload содержит стабильные `projectId`, `serviceId`, имя и разрешённую рабочую директорию.
- Успешный/ошибочный результат runner преобразуется в переход детерминированно, без интерпретации моделью.

## Tasks

- Маршрутизировать этап с кодом `PIPELINE_SERVICE` напрямую в `pipeline-runner`/host worker, не создавая AI agent run и не выбирая LLM-коннектор.
- В контракт claim передавать `projectId`, `serviceId`, каноническое название микросервиса, разрешённый project root/service working directory и ссылку на pipeline-конфигурацию.
- Удалить требование назначения AI-интеграции для `PIPELINE_SERVICE` из конфигурации ролей, seed/preset и валидации проекта; остальные AI-роли не затрагивать.
- Принимать структурированный результат runner и выполнять детерминированный переход: success — следующая включённая роль, failure — `FAILURE_ANALYST`/ошибка согласно pipeline-контракту.
- Исключить `PIPELINE_SERVICE` из любых общих веток LLM-диспетчера и защитить контракт тестом, падающим при попытке вызвать AI-коннектор.

## Acceptance

- Задача Pipeline выдается только не-AI исполнителю вместе с точным микросервисом; для этапа не требуется и не вызывается AI-интеграция.
- Результат команд сохраняется в `pipeline_runs`/событиях и управляет следующим переходом без интерпретации моделью.
- Два микросервиса получают собственные рабочие директории и не могут выполнить pipeline друг друга.

## Orchestrator validation

- `npm test` в `orchestrator-service/backend`.
- Integration P2.4 с fake AI connector, который падает при вызове.
- Проверить success/failure/unknown-service/path-escape и отсутствие agent run/LLM exchange для `PIPELINE_SERVICE`.

## Programmer note (READY_FOR_REVIEW)

Реализовано (роль PROGRAMMER, тесты не запускались):

- **Не-AI исполнитель:** `PIPELINE_SERVICE` уже host-роль и не входит в LLM-диспетчер (`LLM_ROLE_CODES`/`ROLE_PROMPT_FILES` его не содержат). Единственная AI-привязка — seed-агент `claude_pipeline` (anthropic) — заменена локальным `local_pipeline` (`provider='local'`, `model='pipeline-runner'`).
- **Миграция (создана, НЕ применена; меняет данные agents → нужно подтверждение):** `db/migrations/0010_pipeline_local_executor.sql` — добавляет `local_pipeline`, деактивирует `claude_pipeline`. Идемпотентна.
- **Seed/fresh:** правки `db/migrations/0002_role_pipeline.sql` и `db/seed/0001_seed.sql` — свежие БД сразу получают `local_pipeline`.
- **Выбор исполнителя:** `claimNextHostTask` теперь берёт активного агента роли, предпочитая `provider='local'` AI-агенту.
- **Контракт claim:** `src/pipelineDispatch.js` (чистый `buildPipelineClaimContract`/`resolveWorkingDirectory`/`isServicePathSafe`) — claim PIPELINE_SERVICE возвращает `pipeline` DTO: `projectId/serviceId/serviceName/projectRoot/repositoryPath/workingDirectory/pipelineConfigRef`. Неизвестный сервис и path-escape → диагностируемая 422 до запуска команд (claim откатывается).
- **Детерминированный переход:** `completeHostTask` без изменений по сути — success → `COMMIT`/`DOCUMENTATION_AUDITOR`, failure → `FAILURE_ANALYSIS`/`FAILURE_ANALYST`, запись в `pipeline_runs`; LLM не вызывается.
- **Тесты:** `test/pipelineDispatch.test.js` (контракт, path-isolation, гарантия «PIPELINE_SERVICE не LLM-роль»).
- **Контракт-док:** `docs/api-runner-pipeline.md` (для PIPELINE_RUNNER-P1.2 / INTEGRATION-P2.4).

Замечание: «следующая ВКЛЮЧЁННАЯ роль» в части `project_stages.enabled` — отдельный механизм stage-config (P0.1/P2.x); пропуск скрытых ролей обеспечивает фоновый runner (P1.5). Изменений в `pipeline-runner/` нет (вне scope).

next_role: TASK_REVIEWER
