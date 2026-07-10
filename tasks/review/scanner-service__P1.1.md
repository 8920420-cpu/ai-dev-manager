---
id: SCANNER-P1.1
status: review
service: SCANNER
priority: P1
initiative: PIPELINE-STAGE-CONFIG-001
owner: scanner-service
depends_on: ["tasks/orchestrator-service.md → P0.1 фиксирует контракт и источник конфигурации"]
---

# P1.1 PIPELINE-STAGE-CONFIG-001 — обязательная папка наблюдения Scanner

## Description

обязательная папка наблюдения Scanner

## Scope

- `scanner-service/src/`, `scanner-service/bin/`, scanner-конфигурация/health и тесты; compose/docs изменяет последующая роль оркестратора.

## Pre-coding brief (готовит оркестратор)

- К постановке приложена инвентаризация источников `SCANNER_DOCUMENT`/`SCANNER_STATE`, Docker mounts, жизненного цикла watcher и exactly-once state.
- Правило пути зафиксировано: `watchDirectory` является корнем наблюдения, относительное имя документа задаётся отдельной безопасной настройкой с default `claude-tasks.json`; выход `..` и symlink escape за выбранный каталог запрещены.

## Tasks

- Получать конфигурацию включённых Scanner-этапов из orchestrator-service либо из документированного локального snapshot, адресуя watcher по `projectId + stageId`.
- Создавать отдельный watcher с собственным `watchDirectory` для каждого проекта: для проекта ПС наблюдать его каталог `tasks`, для проекта Оркестратор — его каталог `tasks`; не использовать один глобальный путь Scanner для всех проектов.
- Не запускать watcher для этапа `enabled: false`. При динамическом отключении корректно закрывать `fs.watch`, отменять debounce/fallback timers и не отправлять новые completion.
- Для включённого Scanner требовать непустой абсолютный `watchDirectory`; перед стартом проверять существование, тип `directory` и право чтения.
- Нормализовать путь средствами текущей ОС, не подменять host path container path. Для Docker документировать обязательный bind mount и явное сопоставление host→container; отсутствие mount должно давать диагностируемую ошибку, а не молчаливое наблюдение другой папки.
- Ограничить наблюдение выбранным каталогом. Не разрешать относительному имени task document/state path выйти за него через `..`, symlink или абсолютную подстановку без явно документированного разрешения.
- Определить состояние ошибки конфигурации: watcher не стартует, health/readiness сообщает `scanner_watch_directory_unavailable` с `projectId/stageId`, логи не содержат содержимое файлов или токены.
- При смене папки атомарно переключать watcher: сначала проверить новый каталог, затем запустить новый watcher и только после этого закрыть старый; при ошибке сохранить старый рабочий watcher и сообщить об отклонении конфигурации.
- Разделить exactly-once state между watcher (`projectId + stageId + canonical document path`), чтобы разные проекты/папки не подавляли события друг друга.
- Сохранить CLI/env-режим как явно документированный fallback для одиночного watcher; определить приоритет API-конфигурации над `SCANNER_DOCUMENT` и поведение при конфликте.

## Acceptance

- Включённый Scanner с существующей доступной папкой замечает изменение только своего task document и отправляет completion один раз.
- Одновременно настроенные проекты ПС и Оркестратор наблюдают разные каталоги `tasks`; событие в одном каталоге относится только к соответствующему `projectId` и не запускает обработку второго проекта.
- Отключённый Scanner не создаёт watcher, timers и HTTP-вызовы.
- Пустой, относительный, отсутствующий, недоступный или не примонтированный каталог приводит к явной readiness/лог-ошибке с устойчивым кодом.
- Смена папки не создаёт окно двойной доставки и не теряет рабочий watcher при невалидной новой конфигурации.
- Попытка path traversal за пределы выбранной папки отклоняется.
- Unit/integration-тесты покрывают start/stop/reconfigure, несколько проектов, изоляцию state, Docker path mapping и exactly-once доставку.

## Orchestrator validation

- `npm test` в `scanner-service`.
- Integration P2.1 с временными каталогами двух проектов, disable/reconfigure, path traversal и недоступным mount.
- Проверить отсутствие утечек watcher/timer и содержимого task document в логах.
