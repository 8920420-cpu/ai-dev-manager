# scanner-service

Владелец исходников: `scanner-service/`.
Общие правила, статусы, коммиты и порядок выполнения определены в [TASKS.md](../TASKS.md) и [README.md](README.md).

Файловый Scanner отслеживает task document и идемпотентно передаёт завершённые задачи orchestrator-service.

## P1 — scanner-service

### [R] P1.1 PIPELINE-STAGE-CONFIG-001 — обязательная папка наблюдения Scanner

Initiative: `PIPELINE-STAGE-CONFIG-001`
Owner: `scanner-service`
Scope: `scanner-service/src/`, `scanner-service/bin/`, scanner-конфигурация/health и тесты; compose/docs изменяет последующая роль оркестратора.
Dependencies: `tasks/orchestrator-service.md` → P0.1 фиксирует контракт и источник конфигурации.

Pre-coding brief (готовит оркестратор):

- К постановке приложена инвентаризация источников `SCANNER_DOCUMENT`/`SCANNER_STATE`, Docker mounts, жизненного цикла watcher и exactly-once state.
- Правило пути зафиксировано: `watchDirectory` является корнем наблюдения, относительное имя документа задаётся отдельной безопасной настройкой с default `claude-tasks.json`; выход `..` и symlink escape за выбранный каталог запрещены.

Tasks:

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

Acceptance:

- Включённый Scanner с существующей доступной папкой замечает изменение только своего task document и отправляет completion один раз.
- Одновременно настроенные проекты ПС и Оркестратор наблюдают разные каталоги `tasks`; событие в одном каталоге относится только к соответствующему `projectId` и не запускает обработку второго проекта.
- Отключённый Scanner не создаёт watcher, timers и HTTP-вызовы.
- Пустой, относительный, отсутствующий, недоступный или не примонтированный каталог приводит к явной readiness/лог-ошибке с устойчивым кодом.
- Смена папки не создаёт окно двойной доставки и не теряет рабочий watcher при невалидной новой конфигурации.
- Попытка path traversal за пределы выбранной папки отклоняется.
- Unit/integration-тесты покрывают start/stop/reconfigure, несколько проектов, изоляцию state, Docker path mapping и exactly-once доставку.

Orchestrator validation:

- `npm test` в `scanner-service`.
- Integration P2.1 с временными каталогами двух проектов, disable/reconfigure, path traversal и недоступным mount.
- Проверить отсутствие утечек watcher/timer и содержимого task document в логах.

### [!] P1.2 SERVICE-POST-PROGRAMMER-CONCURRENCY-001 — независимый запуск цепочек микросервисов

Блокировка: зависимость `tasks/orchestrator-service.md` → P1.2 (идемпотентный completion-контракт с `blockId` и idempotency key) ещё `[ ]`. До фиксации DTO completion Programmer не реализует.


Initiative: `SERVICE-POST-PROGRAMMER-CONCURRENCY-001`
Owner: `scanner-service`
Scope: Scanner completion/state/HTTP delivery и соответствующие тесты; worker-контексты оркестратора вне scope.
Dependencies: `tasks/orchestrator-service.md` → P1.2 фиксирует идемпотентный completion-контракт и идентификатор блока.

Pre-coding brief (готовит оркестратор):

- Зафиксировать DTO completion с `projectId`, `serviceId`, `blockId` и task IDs, а также idempotency key и подтверждение приёма.
- Единица состояния Scanner — конкретный блок конкретного сервиса; глобальная сериализация между сервисами запрещена.

Tasks:

- Определять завершение всего блока задач Programmer отдельно для каждого `projectId + serviceId`, не ожидая завершения задач других микросервисов проекта.
- При завершении блока отправлять в orchestrator-service один идемпотентный completion, содержащий устойчивые идентификаторы проекта, микросервиса, блока и входящих задач.
- Не удерживать глобальную блокировку на время выполнения последующих ролей: после принятия completion цепочка принадлежит отдельному worker-контексту оркестратора, а Scanner продолжает наблюдать остальные микросервисы.
- Допускать конкурентную доставку completion для микросервисов A и B; сбой или повторная доставка одного микросервиса не должны блокировать другой.
- Хранить exactly-once state раздельно по микросервисам и блоку задач; очищать task document только в границах подтверждённого блока.

Acceptance:

- Завершение задач микросервиса A запускает его цепочку независимо от незавершённых или уже выполняющихся цепочек микросервиса B.
- Одновременное завершение A и B приводит к двум отдельным completion без смешивания задач и без глобальной сериализации Scanner.
- Повторное сканирование или HTTP retry не создаёт вторую цепочку для того же блока.
- Тесты покрывают конкурентное завершение двух микросервисов, частично завершённый блок, retry и изоляцию exactly-once state.

Orchestrator validation:

- `npm test` в `scanner-service`.
- Integration P2.3 с управляемым одновременным завершением A/B, retry и частично завершённым блоком.
- Сверить task IDs и idempotency key в событиях без содержимого исходных task documents.

## P2 — удаление legacy

### [!] P2.1 LEGACY-SCANNER-SINGLE-WATCHER-001 — удалить одиночный env/file bridge

Блокировка: зависит от завершённых Scanner P1.2 (ещё `[!]`) и подтверждённой оркестратором telemetry нулевого использования fallback. Удаление legacy single-watcher/feeder преждевременно.


Initiative: `LEGACY-SCANNER-SINGLE-WATCHER-001`
Owner: `scanner-service`
Scope: legacy feeder/env ветки в `scanner-service/src/` и `bin/`, тесты; compose/README обновляют документационные/интеграционные роли.
Dependencies: завершены P1.1/P1.2 Scanner; оркестратор подтвердил telemetry нулевого использования fallback и переход всех окружений на API-конфигурацию watcher.

Pre-coding brief (готовит оркестратор):

Подтверждённая legacy-логика: `bin/scanner-service.js` напрямую собирает один watcher из `SCANNER_DOCUMENT`/`SCANNER_STATE`, выводит feeder endpoints строковой заменой `SCANNER_ENDPOINT` и запускает polling-мост `TaskFeeder`.

- До Programmer предоставить инвентаризацию окружений, период telemetry без legacy-вызовов и утверждённый rollback.
- Канонический запуск использует только конфигурацию `projectId + stageId` из orchestrator-service.

Tasks:

- После миграционного окна удалить вывод `apiBase` строковой заменой, `FEEDER_*` endpoints и одиночную сборку watcher из `SCANNER_DOCUMENT`/`SCANNER_STATE`.
- Удалить `TaskFeeder` и `/api/runner/next-claude-task`/release-клиент Scanner только после подтверждения, что канонический диспетчер Programmer полностью заменяет файловый обратный мост.
- Оставить явную диагностическую ошибку для устаревших env-переменных, чтобы неверная конфигурация не запускала частично рабочий режим.
- Обновить код health/readiness и тесты на multi-watcher lifecycle без legacy polling. Изменения compose и README передать последующим ролям оркестратора как `documentation_impact: REQUIRED`.

Acceptance:

- Scanner запускается только из канонической конфигурации этапов и не выводит endpoints из других URL.
- В production-коде отсутствуют `TaskFeeder`, `SCANNER_DOCUMENT`, `SCANNER_STATE` и `FEEDER_*`; несколько watcher изолированы по проекту/этапу.
- Повторный запуск, временная недоступность оркестратора и graceful shutdown покрыты integration-тестами без файлового обратного моста.

Orchestrator validation:

- `npm test` в `scanner-service`.
- Поиск production-кода и compose по legacy-символам; Integration P3.1 с multi-watcher, restart и временной недоступностью API.
- Проверить диагностический отказ при устаревших env и отсутствие фонового polling feeder.
- После проверки обновить compose и README через документационные/интеграционные роли оркестратора.
