---
id: ORCHESTRATOR-P1.3
status: ready
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
