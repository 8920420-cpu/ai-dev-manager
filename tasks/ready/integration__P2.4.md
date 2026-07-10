---
id: INTEGRATION-P2.4
status: ready
service: INTEGRATION
priority: P2
initiative: PIPELINE-NON-AI-EXECUTOR-001
owner: integration
depends_on: ["завершены P1.2 pipeline-runner и P1.3 orchestrator-service"]
---

# P2.4 PIPELINE-NON-AI-EXECUTOR-001 — E2E прямого запуска pipeline микросервиса

## Description

E2E прямого запуска pipeline микросервиса

## Scope

- безопасные pipeline fixtures и orchestrator↔runner E2E; product-код вне scope.

## Pre-coding brief (готовит оркестратор)

- Подготовить два disposable service roots и безопасные команды без deploy/network/изменения инфраструктуры.
- Зафиксировать claim/result DTO, допустимые пути и fake AI connector, любой вызов которого немедленно проваливает тест.

## Tasks

- Подготовить микросервисы A и B с различимыми безопасными pipeline-скриптами и перевести задачу A на этап `PIPELINE_SERVICE`.
- Проверить передачу `projectId/serviceId/name/workingDirectory`, выполнение всех действий только скрипта A и структурированное сохранение результата.
- Установить fake AI connector, падающий при любом вызове, и подтвердить полный проход Pipeline без обращения к нему.
- Проверить успешный переход, ошибку команды, неизвестный serviceId и попытку выхода рабочей директории за project root.

## Acceptance

- E2E проходит при полностью недоступных AI-коннекторах для роли Pipeline; AI-вызовов нет.
- Выполняется только pipeline выбранного микросервиса, а результат детерминированно направляет задачу на следующий этап или failure analysis.

## Orchestrator validation

- Запустить unit suites orchestrator/pipeline-runner и E2E для success/failure/unknown service/path traversal.
- Проверить отсутствие prompt exchange/AI agent run и удалить временные service roots/processes.
