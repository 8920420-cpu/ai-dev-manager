---
id: PIPELINE_RUNNER-P1.2
status: review
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

## Programmer note (READY_FOR_REVIEW)

### Изменённые/созданные файлы
- `pipeline-runner/src/ServicePipelineTask.js` (новый) — сервисный (не-AI) слой запуска этапа `PIPELINE_SERVICE` по claim оркестратора: валидация контракта `task.pipeline`, выбор сервиса строго по `serviceId`, path isolation на реальных абсолютных путях, загрузка `.pipeline.json` выбранного сервиса, запуск штатным `PipelineRunner`/`StageRunner`, сборка structured-результата для `POST /api/runner/host-task-completed`.
- `pipeline-runner/src/PipelineRunner.js` — `execute()` теперь дополнительно возвращает поле `summary` (обратная совместимость сохранена); сервисный слой строит из него `actions[]`.
- `pipeline-runner/src/StageRunner.js` — на каждую команду собирается безопасный «хвост» вывода (`logFragment`, ≤2000 символов); полный вывод по-прежнему только в `pipeline.log`.
- `pipeline-runner/src/index.js` — реэкспорт нового публичного API (`ServicePipelineTask`, `runServicePipeline`, `resolveServicePaths`, и т.д.).
- `pipeline-runner/bin/pipeline-runner.js` — добавлен сервисный режим `--task <claim.json|-> --projects-root <abs>`; прежний режим `--config` не изменён.
- `pipeline-runner/test/ServicePipelineTask.test.js` (новый) — unit-тесты: отсутствие AI-вызовов (tripwire-коннектор как proxy, бросающий при любом обращении), выбор сервиса A vs B по `serviceId`, выполнение всех действий, unknown service, path traversal, конфиг с `workingDirectory` за пределами проекта, форма structured-результата.
- `pipeline-runner/test/integration.test.js` — добавлены сквозные тесты сервисного режима через реальный shell (успех + ограниченный `logFragment`, реальное падение → `failedStage`).
- `pipeline-runner/README.md` — раздел «Сервисный режим PIPELINE_SERVICE (без AI)» и строка архитектуры.

### Ключевые решения
- Сервис определяется ТОЛЬКО по устойчивому `serviceId` из контракта; свободный текст/prompt/CWD не используются. AI-зависимости в слое нет физически — это и проверяет tripwire-тест.
- Path isolation сделана двухуровневой и продублирована на стороне runner (defense in depth, не доверяем серверной проверке слепо): (1) относительная проверка пути сервиса/projectRoot как в серверном `pipelineDispatch`; (2) проверка вложенности РАЗРЕШЁННЫХ абсолютных путей по сегментам (`isInsideRoot`), включая `workingDirectory` из самого `.pipeline.json` — конфиг не может увести запуск за корень проекта.
- Требуется абсолютный `projectsRoot` (корень проектов на хосте), от которого резолвятся POSIX-относительные `projectRoot`/`repositoryPath` контракта в реальные пути.
- Любая проблема контракта/изоляции/отсутствия конфига → `success:false` с диагностируемым `output.summary.error.code` (`pipeline_service_required` | `pipeline_service_path_escape` | `pipeline_working_directory_unresolved` | `pipeline_project_required` | `pipeline_projects_root_required`) ДО запуска любой команды (в тестах подтверждается `executor.calls.length === 0`).
- Структурированный результат: `output.summary` несёт `projectId`/`serviceId`/`serviceName` и `actions[]` (status, exitCode, durationMs, безопасный `logFragment`); неограниченный вывод/секреты в summary не попадают.

### Остаточные риски
- Интеграция в host-runner (`host-runner/src/actions.js` сейчас игнорирует `task.pipeline` и гоняет тесты самого pipeline-runner) НЕ трогалась — это вне scope роли PROGRAMMER (P1.2 = `pipeline-runner/*`). Подключение нового слоя к host worker и проброс реального `projectsRoot` — отдельная задача (host-runner / INTEGRATION-P2.4).
- Тесты написаны, но по правилам роли НЕ запускались (`npm test` не выполнялся). Валидацию `npm test` и P2.4 выполняет оркестратор.
- `FakeExecutor` не вызывает `onStdout/onStderr`, поэтому `logFragment` в unit-тестах с фейком пуст (это ожидаемо); покрытие `logFragment` обеспечивает integration-тест через реальный shell.

next_role: TASK_REVIEWER
