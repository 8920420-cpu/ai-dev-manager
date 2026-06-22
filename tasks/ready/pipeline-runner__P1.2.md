---
id: PIPELINE_RUNNER-P1.2
status: ready
service: PIPELINE_RUNNER
priority: P1
initiative: PIPELINE-NON-AI-EXECUTOR-001
owner: pipeline-runner
depends_on: ["tasks/orchestrator-service.md → P1.3 фиксирует claim/result payload и правила перехода до реализации"]
---

# P1.2 PIPELINE-NON-AI-EXECUTOR-001 — запуск pipeline без AI-роли

## Description

запуск pipeline без AI-роли

## Scope

- `pipeline-runner/src/`, `pipeline-runner/bin/` и `pipeline-runner/test/`; без backend-диспетчера orchestrator-service.

## Pre-coding brief (готовит оркестратор)

- К постановке приложена схема текущего пути `PIPELINE_SERVICE`: claim задачи, формирование контекста, выбор рабочей директории, загрузка `.pipeline.json`, запуск команд и возврат результата.
- Claim/result DTO и правила допустимой рабочей директории зафиксированы результатом orchestrator P1.3; Programmer их не проектирует.

## Tasks

- Запускать этап Pipeline обычным сервисным worker без обращения к LLM, AI-коннектору, prompt или модели.
- При переходе на этап принимать от оркестратора устойчивые `projectId`, `serviceId`, название микросервиса и его разрешённую рабочую директорию.
- Загружать pipeline-скрипт/конфигурацию именно выбранного микросервиса и последовательно выполнять все объявленные в нём действия штатным `PipelineRunner`/`StageRunner`.
- Не определять микросервис по свободному тексту, prompt или текущей директории процесса; сверять `serviceId` и путь с серверным контрактом и разрешённым корнем проекта.
- Возвращать структурированный результат каждого действия: статус, длительность, exit code и безопасный фрагмент лога; не передавать результат через AI-роль.
- Запретить выполнение скрипта соседнего микросервиса и выход рабочей директории за разрешённый корень; неизвестный/удалённый сервис завершать диагностируемой ошибкой до запуска команд.

## Acceptance

- Переход на `PIPELINE_SERVICE` для микросервиса A запускает все действия pipeline-скрипта A без единого вызова AI-коннектора.
- В payload и логах присутствуют `projectId`, `serviceId` и название микросервиса; скрипты микросервиса B не запускаются.
- Успех/ошибка команд напрямую переводят задачу на следующий этап либо в failure analysis по контракту оркестратора.
- Unit/integration-тесты проверяют отсутствие LLM-вызовов, выбор правильного сервиса, выполнение всех действий, path isolation и структурированный результат.

## Orchestrator validation

- `npm test` в `pipeline-runner`.
- Integration P2.4 с двумя различимыми сервисами, fake AI connector и сценариями unknown service/path traversal.
- Проверить структурированный result и отсутствие токенов/неограниченного вывода команд в логах.
