# DECISIONS.md

> Архитектурные решения проекта (ADR). Источник истины для всех агентов.
> Каждое решение неизменяемо; новое решение, отменяющее старое, добавляется
> следующим ADR со ссылкой на предыдущий.

---

## ADR-001 — PostgreSQL как источник истины

**Дата:** 2026-06-21
**Решение:** Состояние оркестратора (задачи, статусы, история) хранится в
PostgreSQL (`orchestrator_db`).
**Причина:** транзакционность, надёжность, `FOR UPDATE SKIP LOCKED` для
конкурентного распределения задач.
**Последствия:** все компоненты читают/пишут состояние только через БД; нет
скрытого состояния в памяти агентов.

---

## ADR-002 — UUID для всех первичных ключей

**Дата:** 2026-06-21
**Решение:** Все PK — `uuid` (`gen_random_uuid()`).
**Причина:** генерация ID без обращения к БД, безопасное слияние данных,
отсутствие гонок по sequence при десятках агентов.
**Последствия:** новые таблицы обязаны использовать `uuid PRIMARY KEY`.

---

## ADR-003 — Статусы через ENUM и справочники

**Дата:** 2026-06-21
**Решение:** Статусы хранятся как ENUM-типы; роли/агенты — справочные таблицы.
**Причина:** контроль допустимых значений на уровне БД, читаемость.
**Последствия:** расширение статусов — через миграцию `ALTER TYPE ... ADD VALUE`.

---

## ADR-004 — Append-only история и аудит

**Дата:** 2026-06-21
**Решение:** `task_events` и `context_snapshots` неизменяемы (триггеры
блокируют UPDATE/DELETE); промты версионируются и не удаляются.
**Причина:** воспроизводимость и расследование решений ИИ.
**Последствия:** исправления — только новой записью, не правкой старой.

---

## ADR-005 — Конкурентность через FOR UPDATE SKIP LOCKED

**Дата:** 2026-06-21
**Решение:** Задачи распределяются `SELECT ... FOR UPDATE SKIP LOCKED`.
**Причина:** безопасная работа десятков агентов без конфликтов записи и без
внешнего брокера очередей.
**Последствия:** воркеры обязаны брать задачи только этим паттерном.

---

## ADR-006 — Блокировка микросервисов

**Дата:** 2026-06-21
**Решение:** Один сервис изменяется одним агентом — `service_locks` +
частичный уникальный индекс (`released_at IS NULL`).
**Причина:** исключить одновременные конфликтующие правки одного сервиса.
**Последствия:** перед изменением сервиса агент обязан взять лок; снятие —
проставлением `released_at`.

---

## ADR-007 — Pipeline через `.pipeline.json`

**Дата:** 2026-06-21
**Решение:** CI/CD-этапы описываются в `.pipeline.json`; pipeline-runner не
содержит проектной логики и не зависит от языка.
**Причина:** единый запускатель для разных стеков, изоляция запусков.
**Последствия:** каждый проверяемый проект обязан иметь `.pipeline.json`.

> **Обновление (2026-07-03, ADR-007a — конвенционный режим).** В сервисном
> режиме исполнения (`runServicePipeline`/`ServicePipelineTask`) `.pipeline.json`
> стал НЕОБЯЗАТЕЛЬНЫМ. Если у сервиса нет локального `.pipeline.json`, движок сам
> строит стадии по конвенции монорепо, зная только путь сервиса и корень проекта
> (`ConventionConfigBuilder`):
> - **test** — `go.mod` → `go test ./...`; `package.json` с непустым скриптом
>   `test` → `npm test`; иначе стадия SKIPPED (`no_tests_detected`);
> - **build** — ближайший вверх `docker-compose.yml`/`compose.yml` (граница
>   подсистемы, не выходя за корень проекта) → `docker compose -f <compose> build`;
> - **deploy** — тот же compose → `docker compose -f <compose> up -d`; если compose
>   не найден — диагностируемая ошибка стадии deploy (`pipeline_compose_not_found`).
>   После SERVICE-REPO-PATH-001 (ADR-014) этот исход достижим только когда каталог
>   сервиса РАЗРЕШЁН (`repository_path` указывает на существующий каталог), но
>   compose в подсистеме не найден; пустой/устаревший `repository_path` больше не
>   проходит как «сборка от корня» — он перехватывается раньше, на claim
>   PIPELINE_SERVICE, провалом `service_path_unresolved`;
> - **smoke** — если в compose объявлен healthcheck → `docker compose -f <compose>
>   up -d --wait`; иначе стадия SKIPPED (`no_healthcheck_in_compose`).
>
> Локальный `.pipeline.json` остаётся необязательным ПЕРЕОПРЕДЕЛЕНИЕМ конвенции:
> целиком (по умолчанию) либо постадийно (`extendsConvention: true` — одноимённые
> стадии переопределяются, новые добавляются). Compose-файл не парсится (без
> YAML-зависимости): подсистема = ближайший compose целиком, healthcheck
> детектируется текстовым поиском. Логика дефолтов централизована в
> `ConventionConfigBuilder` — правка применяется сразу ко всем сервисам, копии
> `.pipeline.json` по репозиториям не заводятся. Тезисы «каждый проект обязан
> иметь `.pipeline.json`» и «не содержит проектной логики / не зависит от языка»
> действуют только для прямого запуска по конфигу; сервисный режим детектит стек
> (go/node) и подсистему (compose).
>
> Тогда же удалён легаси-фолбэк host-runner (заглушка «самотесты
> pipeline-runner» + env `HOST_PIPELINE_CONFIG/DIR/CMD`): контракт claim
> (`task.pipeline`) обязателен — оркестратор строит его при выдаче задачи или
> отклоняет claim с 422; задача без контракта теперь падает диагностируемо
> (`pipeline_contract_missing`), а не завершается ложным успехом за секунды.

---

## ADR-008 — Документация как источник контекста

**Дата:** 2026-06-21
**Решение:** `docs/` (PROJECT_MAP, ARCHITECTURE, API_MAP, DATABASE_MAP,
DECISIONS) — основной контекст агентов; версии фиксируются в
`knowledge_documents` и `context_snapshots`.
**Причина:** агент должен понимать систему без чтения всего кода.
**Последствия:** после каждой значимой задачи документы обновляются. При
конфликте кода и документации **устаревшей считается документация** — её
обновляют, код не меняют ради соответствия документам.

---

## ADR-009 — Использование Docker

**Дата:** 2026-06-21
**Решение:** Все сервисы и инфраструктура (PostgreSQL, Redis, MinIO) работают
в Docker.
**Причина:** воспроизводимость окружения, изоляция.
**Последствия:** новые сервисы поставляются с Dockerfile и записью в compose.

---

## ADR-010 — Коннекторы-драйверы (Codex, Claude Code) — ROLE-ENGINE-ROUTING-001

**Дата:** 2026-07-03
**Решение:** Введён тип провайдера коннектора `driver` со значениями `codex` и
`claude_code`. Такие коннекторы не имеют HTTP-endpoint и `access_token`
(`endpointForProvider` возвращает пустую строку) и исполняются хостовыми
движками через generic-контракт `next-reasoning-task`, а не через
`invokeConnector`. В `src/connectors.js` guard (`isDriverProvider` /
`DRIVER_PROVIDERS`) отклоняет прямой HTTP-вызов драйвер-коннектора — ошибка
`422 connector_driver_not_invocable`. Записи `Codex` и `Claude Code`
сидируются идемпотентно миграцией `0036_driver_connectors.sql`
(`INSERT ... ON CONFLICT (lower(name)) DO NOTHING`).
**Причина:** драйверные исполнители принципиально отличаются от сетевых
AI-API — их нельзя вызывать как обычный HTTP LLM endpoint; guard предотвращает
случайный прямой вызов.
**Последствия:** роль может выбрать `Codex`/`Claude Code` как коннектор
исполнения через существующий список `/api/connectors` и штатную валидацию
`connector_id`; существующие `deepseek`/`openai`-коннекторы не затронуты. Новые
драйвер-провайдеры добавляются в `DRIVER_PROVIDERS`.

---

## ADR-011 — Интеграции обращений роли Task Intake Officer — INTAKE-INTEGRATIONS-001

**Дата:** 2026-07-03
**Решение:** Введён третий канал приёма роли Task Intake Officer —
«интеграции в приложения». Реестр внешних приложений-источников хранится в
таблице `intake_integrations` (миграция `0043_intake_integrations.sql`) БЕЗ
обязательной привязки к проекту. Открытый endpoint `POST /api/intake/report`
принимает обращение с авторизацией по **токену интеграции** (заголовок
`Authorization: Bearer <token>` / `X-Intake-Token` / поле `token` в теле), мимо
`ORCHESTRATOR_API_TOKEN`. Ключевые принципы:
- Токен интеграции хранится только как SHA-256 (`token_hash`); наружу секрет не
  отдаётся — только флаг `has_token`. Перевыпуск — `POST
  /api/intake-integrations/:id/rotate-token`.
- Обращения принимаются беспроектными (сразу `BACKLOG` под Приёмщиком, не
  «Неразобранные»); проект определяет сам Приёмщик по каталогу проектов —
  промт роли `TASK_INTAKE_OFFICER` дополнен блоком «Channel: application
  integrations» (подсказки: микросервис-источник и форма).
- Идемпотентность по паре `(intake_integration_id, external_id)` (частичный
  уникальный индекс `uniq_tasks_integration_external`); человекочитаемый номер
  обращения — последовательность `intake_report_seq` («Заявка №X принята»).
- Анти-спам на стороне оркестратора: rate-limit по интеграции
  (`rate_limit_per_min`) и по пользователю (`user_rate_limit_per_min`),
  отклонение коротких сообщений (`min_message_length`).
- Ссылка на скриншот (объект MinIO) сохраняется в карточке задачи и доступна
  следующим ролям.
- Поля обращения (`reporterService`, `reporterForm`, `autocontext`,
  `screenshotUrl`, `category`) прокидываются в контекст роли только для
  задач-обращений (`tasks.intake_integration_id IS NOT NULL`) и только Приёмщику —
  функция `buildIntakeReportContext` (`orchestrator-service/backend/src/db.js`);
  объём капится (напр. `jsErrors` — первые 10 строк с обрезкой длины).
- Категория из виджета (`category`, `bug|idea|feature|question`) — подсказка
  пользователя (`user_category`), не истина: Приёмщик перепроверяет соответствие
  тексту сообщения и фиксирует `resolved_category` (при переопределении — с
  коротким обоснованием). Маппинг `resolved_category` → `task_type` карточки:
  `bug→bug`, `idea→improvement/idea`, `feature→feature`, `question→question`.
**Причина:** конечные пользователи продуктов должны сообщать о проблемах
изнутри приложений, а обращения — попадать штатным потоком приёма без ручного
назначения проекта.
**Последствия:** канал «интеграции» не смешивается с «Движком» роли и
коннекторами (`connectors`): движок — чем роль думает, интеграции — откуда
приходят обращения. Управление реестром — раздел «Интеграции» в карточке роли
Task Intake Officer (`/api/intake-integrations`). Вне объёма v1: личный список
«мои заявки», дедуп похожих обращений, расширенная аналитика в Мониторе,
подключение приложений вне ПС.

---

## ADR-012 — Вердикты reasoning-ролей: fenced YAML/JSON и авто-ретрай вместо FAILED — VERDICT-RETRY-001

**Дата:** 2026-07-03
**Коммит:** ed57314
**Решение:** Обработка вердиктов reasoning-ролей усилена в двух местах:
- `parseVerdict` (`orchestrator-service/backend/src/roleEngine.js`) теперь
  распознаёт вердикт не только «голым» JSON, но и внутри код-фенсов
  ```` ```json ```` и ```` ```yaml ````: YAML-блок парсится и приводится к тому
  же объекту вердикта, что и JSON. Ранее распознавался только чистый JSON
  (доработка VERDICT-PARSE-ROBUST-001).
- Исход `verdict_unparsed` больше НЕ роняет задачу сразу в терминальный
  `FAILED`. Прогон роли авто-повторяется до лимита `RUNNER_MAX_VERDICT_RETRY`
  (env, `resolveInt`, default `1`, min `0`, max `10`; `0` = прежнее поведение
  без ретраев). Только после исчерпания лимита возвращается прежнее поведение —
  терминальный `FAILED` со `STATUS_CHANGED → FAILED`, `reason=verdict_unparsed`
  (`orchestrator-service/backend/src/db.js`). Сырой ответ модели остаётся в
  `prompt_exchanges`, диагностика — в `agent_runs.error_text` + `output_json`.
**Причина:** движок `claude_code` (Claude Agent SDK, см. ADR-010) не умеет
навязать JSON-схему вердикта на уровне CLI — в отличие от codex с
`--output-schema`, — поэтому TASK_REVIEWER периодически возвращает содержательно
корректный вердикт (например `status: APPROVED`) в код-фенсе ```` ```yaml ````,
что давало `verdict_unparsed` и немедленный ручной разбор (за 24 ч ~10% прогонов
TASK_REVIEWER).
**Последствия:** содержательно корректные вердикты в fenced YAML/JSON более не
теряются; единичный сбой парсинга гасится авто-повтором, а не терминальным
падением. Семантика вердиктов и маршруты ролей не изменены. Регулировка числа
повторов — через env `RUNNER_MAX_VERDICT_RETRY`.

---

## ADR-013 — Архитектор расщепляет мультисервисную задачу на независимые задачи-по-сервисам — ARCH-SERVICE-SPLIT-001

**Дата:** 2026-07-03
**Решение:** При вердикте роли `ARCHITECT` с `outcome=FORWARD` в
`applyReasoningVerdict` (`orchestrator-service/backend/src/db.js`) разбивка
берётся через `normalizeWorkItems(data_card + verdict.fields + cardValues)`;
сервисы резолвятся по `services` проекта регистронезависимо. Если резолвится
**≥2 разных зарегистрированных сервиса** — вместо `ensureArchitectService`
вызывается `materializeArchitectSplit` (по образцу `materializeDecomposition`,
один txn):
- на каждый сервис создаётся **независимая дочерняя задача** `task_kind='service'`,
  `parent_task_id`=исходная задача, тот же `project_id`, свой `service_id`,
  `title = work_items[i].title`, `description` = описание исходной задачи +
  раздел «Задание для сервиса `<serviceCode>`» с `files`/`what` только этого
  сервиса, `data_card` = карточка родителя (+ поля вердикта Архитектора) с
  **отфильтрованными по сервису** `work_items`/`affected_files`,
  `created_by='architect'`;
- дети входят в маршрут переходом `FORWARD` Архитектора: в граф-режиме (у
  исходной задачи есть `current_stage_key`) — целевой узел Programmer через
  `resolveGraphTransition`, детям проставляется `current_stage_key` целевого
  этапа; в линейном — `resolveTransition` (обычно `CODING`/`PROGRAMMER`). Дети
  не зависят друг от друга и идут по конвейеру независимо
  (`CODING → REVIEW → TESTING → COMMIT …`);
- исходная задача становится эпиком: `task_kind='epic'`,
  `status='WAITING_FOR_CHILDREN'`, `assigned_agent_id=NULL`; пишется событие
  `STATUS_CHANGED` (role `ARCHITECT`, `reason='architect_service_split'`, в
  payload — список созданных задач `{id, serviceCode}` и `unresolved`-сервисы);
  `agent_run` Архитектора завершается `SUCCESS` с outcome и статистикой.
- **Идемпотентность:** если у задачи уже есть дети (`SELECT 1 FROM tasks WHERE
  parent_task_id = …`) — повторно задачи не создаются, прогон финализируется
  `reason='already_decomposed'`.
- **0 или 1 сервис** — поведение не меняется (`ensureArchitectService`: одна
  задача; 0 сервисов → `BLOCKED architect_no_service`). Нерезолвленные
  `serviceCode` при расщеплении попадают в `unresolved` в payload события, задач
  по ним не создаётся.
- **Роллап:** `rollupDecompositionEpics` закрывает эпики с детьми
  `task_kind='service'` (все дети терминальны → `DONE`; есть `BLOCKED`/`FAILED`
  → `BLOCKED`).
- **Сверка покрытия сервисов (JOIN-PLANNED-COVERAGE-001):** при декомпозиции
  Архитектор фиксирует целевой список сервисов в `data_card.planned_services`
  (`computePlannedServices`: `affected_services ∪ work_items`, канонические коды
  зарегистрированных сервисов, дедуп). При роллапе фактические дети-`service`
  сверяются с `planned_services`: сервис считается покрытым, если у него есть
  хотя бы один НЕ отменённый ребёнок `task_kind='service'` (сверка по коду
  сервиса, а не по числу детей). Если не все заявленные сервисы покрыты — эпик
  НЕ закрывается `DONE`, а переводится в `BLOCKED` (возврат Архитектору) с
  событием `reason='epic_missing_services'` и перечнем недостающих сервисов в
  `payload.missingServices`. Недостача покрытия приоритетно понижает
  `DONE → BLOCKED`. Мотив: у эпика B1 (заявлены `WEBSTORE/Smeta/IAM/FastTable`,
  дети созданы только на `WEBSTORE`+`IAM` из-за капов/таймаутов Архитектора)
  `DONE` по имеющимся детям скрыл, что половина фронтов не сделана.
**Причина:** ранее при `FORWARD` `ensureArchitectService` резолвил ПЕРВЫЙ
зарегистрированный сервис, и вся работа уходила Programmer одной задачей, даже
если затронуты 2+ сервисов. Промт Архитектора (`arch-service-split-v1`) всегда
заполняет `work_items` — ровно один элемент на затронутый сервис.
**Последствия:** задача Архитектора, затрагивающая сервисы A и B, после его
вердикта превращается в две независимые задачи (по одной на сервис), каждая
проходит конвейер отдельно, а родитель-эпик закрывается роллапом после
завершения детей. Claim программиста (`claimNextClaudeTask`) не затронут: дети
kind='service' со `status='CODING'` и `service_id` клеймятся (фильтр
`task_kind <> 'epic'`), сериализация «один активный CODING на сервис»
(NOT EXISTS + advisory lock) сохраняется.

---

## ADR-014 — Резолвинг каталога сервиса (services.repository_path) для сервисного пайплайна — SERVICE-REPO-PATH-001

**Дата:** 2026-07-04
**Решение:** `services.repository_path` (каталог сервиса относительно корня
проекта) заполняется автоматически и валидируется до запуска сервисного
конвейера. Логика вынесена в `orchestrator-service/backend/src/serviceRepoPath.js`:
- **Авторегистрация сервиса.** При авторегистрации `services.repository_path`
  выводится из общего каталогового префикса путей `files`/`changedFiles`
  work_item (`deriveServicePathFromFiles`) и пишется в `INSERT services`
  (`orchestrator-service/backend/src/db.js` ~1256; вызов подготовки пути ~563–564).
- **Валидация и ленивый бэкфилл на claim PIPELINE_SERVICE.** На выдаче задачи
  роли `PIPELINE_SERVICE` путь резолвится `resolveServiceRepoPath(rootPath,
  serviceCode, repository_path)` (`db.js` ~1911–1925): (1) текущий
  `repository_path` валиден и каталог существует в корне проекта → оставить как
  есть; (2) иначе — бэкфилл по коду сервиса (`findServiceDirByCode` — точное
  совпадение имени каталога на глубине ≤3; найден ровно один — записать в
  `services.repository_path` через `UPDATE`); (3) иначе — НЕ запускать конвейер
  от корня, а вернуть диагностируемый провал `service_path_unresolved`
  (`scannerError(422)`, сообщение «сервис X: repository_path не задан/не найден,
  укажите каталог сервиса») ДО построения стадий и запуска команд.
**Причина:** у сервисов, авторегистрируемых по work_items, `repository_path` был
`NULL` → `workingDirectory` = корень проекта → конвенция искала
`docker-compose.yml` от корня монорепо, где его нет (компоузы лежат в
подсистемах), и каждый прогон PIPELINE_SERVICE мгновенно падал
`pipeline_compose_not_found`. У части сервисов путь был заполнен, но устарел
(каталога уже нет в репозитории).
**Последствия:** задача по сервису с известным каталогом проходит с реальным
build/deploy подсистемы; сервис без разрешимого каталога даёт понятный провал
`service_path_unresolved` с текстом причины (вместо `pipeline_compose_not_found`
от корня). `pipeline_compose_not_found` (ADR-007a) теперь достижим только когда
каталог сервиса разрешён, но compose в подсистеме не найден.

## ADR-015 — Бюджет и диагностика Архитектора на мега-эпиках; общий кап перезапусков этапа — ARCHITECT-BUDGET-SCALE-001 / ARCHITECT-BUDGET-LOOP-001 / TASK-RUN-LOOP-CAP-001 / ROLE-TIMEOUT-001

**Дата:** 2026-07-04
**Коммит:** b56c936
**Решение:** четыре связанных механизма оркестрации против «молчаливого BLOCKED»,
когда Архитектор не укладывается в бюджет одного прогона на крупном эпике.

- **ROLE-TIMEOUT-001 — персональный таймаут прогона по роли.** Reasoning-раннеры
  (`codex-runner/src/ReasoningRunner.js`, `programmer-runner/src/ReasoningRunner.js`)
  получили карту `roleTimeoutsMs`; `resolveTaskTimeoutMs(role)` берёт таймаут роли
  из карты, иначе общий `taskTimeoutMs`. `scripts/start-runners.ps1` задаёт
  Архитектору `ARCHITECT_TASK_TIMEOUT_MS` (дефолт `1200000` = 20 мин) вместо общих
  540 с. Орфан-таймаут рассуждающей роли поднят: `RUNNER_ROLE_TIMEOUT_MS=1500000`
  (25 мин, было 600000/10 мин) в `.env.example`. Контракт цепочки: орфан (25 мин) >
  бюджет Архитектора (20 мин) > общий hard-timeout рассуждающих раннеров (9 мин).
- **ARCHITECT-BUDGET-SCALE-001 — масштабирование капа ходов по размеру эпика.**
  `resolveRoleMaxTurns(roleCode, sizeCtx)` (`orchestrator-service/backend/src/roles.js`)
  для роли `ARCHITECT` масштабирует базовый кап (`ROLE_MAX_TURNS_DEFAULTS.ARCHITECT=24`)
  по описанию задачи. Сигнал размера доступен на claim только из описания (work_items
  ещё не созданы — их производит Архитектор): `estimateEpicServiceCount` парсит явно
  названное число сервисов/фронтов («14 фронтов»), плюс длина описания как прокси
  объёма. Параметры `ARCHITECT_TURN_SCALE`: `perService:3`, `perKChars:2`,
  `baseServices:2`, `baseChars:2000`, потолок `max:60`. Масштабируется ТОЛЬКО
  Архитектор; вызов на claim — `db.js` `claimNextReasoningTask` с `{ description }`.
- **ARCHITECT-BUDGET-LOOP-001 — диагностируемый блок мега-эпика.**
  `escalateArchitectBudgetLoop` (`db.js`, свипер в `advanceAutomatedTasks`): после
  `K = ARCHITECT_BUDGET_LOOP_MAX` (дефолт 3) подряд `CANCELLED`/`TIMEOUT`-прогонов
  Архитектора (окно — после последнего `SUCCESS`) `ARCHITECTURE`-задача уходит в
  `BLOCKED` С ПРИЧИНОЙ: в `data_card.architect_budget_block` (`{reason, cancelledRuns}`)
  и в событии `TASK_BLOCKED` (`reason='architect_budget_exhausted'`). Текст причины
  подсказывает действие: разбить эпик на пакеты по 4–5 сервисов/фронтов и вернуть в
  ARCHITECTURE, либо увеличить бюджет.
- **TASK-RUN-LOOP-CAP-001 — общий предохранитель для любой роли.**
  `escalateRunawayRoleLoops` (`db.js`, свипер в `advanceAutomatedTasks`): после
  `K = TASK_RUN_LOOP_MAX` (дефолт 5) подряд оборванных без вердикта
  (`CANCELLED`/`TIMEOUT`) прогонов текущей роли задача уходит в `BLOCKED` с причиной в
  `data_card.auto_run_limit` (`{reason, cancelledRuns, role}`) и событии `TASK_BLOCKED`
  (`reason='run_budget_exhausted'`). Порог выше архитекторского — узкие жнецы
  (Архитектор `ARCHITECT_BUDGET_LOOP_MAX=3`) срабатывают раньше со своим диагнозом;
  этот — страховка для остальных ролей. Дальше — пуск руками (move на этап).
**Причина:** мега-эпик (раскатка на N сервисов/фронтов с пофайловыми инструкциями)
упирался в reasoning-таймаут 540 с БЕЗ вердикта, прогон отменялся/гасился жнецом,
задача переигрывалась по кругу и без диагноза уходила в молчаливый `BLOCKED` (инцидент
2026-07-04: PS-FEEDBACK-WIDGET-ROLLOUT-001 — три `CANCELLED` подряд по ~547 с).
**Последствия:** Архитектор получает больший бюджет времени/ходов на крупных эпиках;
при реальном неуложении задача блокируется С ВНЯТНОЙ ПРИЧИНОЙ в карточке (не молча) и
требует ручного перезапуска; пороги/таймауты настраиваются через env
(`ARCHITECT_TASK_TIMEOUT_MS`, `RUNNER_ROLE_TIMEOUT_MS`, `ARCHITECT_BUDGET_LOOP_MAX`,
`TASK_RUN_LOOP_MAX`, `ARCHITECT_MAX_TURNS`).

---

## ADR-016 — Устойчивость финализации прогона роли к транзиентным обрывам БД — DB-FINALIZE-RETRY-001

**Дата:** 2026-07-04
**Коммит:** 15e0251
**Решение:** Финализация прогона рассуждающей роли (запись вердикта/перехода/
`agent_run`, а также FAILED- и `verdict_unparsed`-исходов) в `processClaimedRole`
(`orchestrator-service/backend/src/db.js`) выполняется через
`finalizeWithConnRetry` — ограниченный ретрай записи результата на свежем
соединении из пула.
- **Ретрай только записи результата.** Под повтор попадает исключительно запись
  результата прогона; LLM-вызов НЕ повторяется.
- **Класс ошибок.** Повтор срабатывает только при ошибках класса соединения
  (`isDbConnectionError`: коды `08xxx`/`57P01`, а также «Connection terminated»);
  ошибки иного класса пробрасываются без повтора.
- **Backoff.** Зашит константой `FINALIZE_RETRY_BACKOFF_MS=[100,200,400]` мс
  (env-настройки нет).
- **Идемпотентность.** Повторная финализация того же `agent_run` не задваивает
  события/переходы: `isRunAlreadyFinalized` возвращает `alreadyFinalized: true`.
- **Исчерпание ретраев.** Ошибка не глотается молча — логируется; прогон остаётся
  в состоянии, из которого его подбирает per-tick сброс `RUNNING`
  (ORCH-REAP-PERTICK-001).
**Причина:** после рестарта контейнера идёт короткий шторм «Connection terminated
unexpectedly» (pgbouncer/Patroni HA); если обрыв попадал на момент финализации,
шаг падал, ошибка глоталась в `advanceAutomatedTasks` через `.catch(() => null)`,
а прогон оставался в `RUNNING` (накоплены сотни FAILED/TIMEOUT: ARCHITECT ~130
FAILED, TASK_INTAKE_OFFICER ~48 TIMEOUT).
**Последствия:** одиночный транзиентный обрыв соединения во время финализации не
приводит к потере результата прогона и не оставляет задачу в зависшем `RUNNING`;
повторная финализация идемпотентна. Новых env, эндпоинтов и изменений схемы БД
не вводится.

---

## ADR-017 — Cooldown и предохранитель PROGRAMMER release-loop — PROGRAMMER-RELEASE-BACKOFF-001

**Дата:** 2026-07-09
**Решение:** повторный claim одной и той же `CODING`-задачи роли `PROGRAMMER` после
неудачного release задерживается на стороне оркестратора в `claimNextClaudeTaskTx`
(`orchestrator-service/backend/src/db.js`). Cooldown считается по числу подряд идущих
PROGRAMMER-прогонов со статусом `FAILED`/`TIMEOUT` после последнего `SUCCESS` этой
задачи. Дефолтное расписание задержек: `[30000,120000,600000]` мс (`30s → 2m → 10m`),
с потолком на последнем значении; переопределяется через
`PROGRAMMER_RELEASE_BACKOFF_MS_SCHEDULE`.

`POST /api/runner/release-claude-task` финализирует последний `RUNNING` PROGRAMMER
`agent_run`: обычный release пишет `FAILED`, `reason=agent_timeout` пишет `TIMEOUT`.
Успешная сдача сбрасывает счётчик не отдельным полем, а окном подсчёта: учитываются
только `FAILED`/`TIMEOUT` после последнего `SUCCESS`.

Предохранитель `escalateProgrammerReleaseLoop` переводит `CODING`-задачу без
`assigned_agent_id` в `BLOCKED` после `PROGRAMMER_RELEASE_LOOP_MAX` подряд таких
провалов; дефолт порога — `5`. Событие `STATUS_CHANGED` содержит
`reason='programmer_release_loop'` и `failedRuns`.
**Причина:** инцидент 2026-07-03: задача PRINT-054 за два часа дала 1407 коротких
провальных PROGRAMMER-прогонов подряд; при одном активном программисте это полностью
заблокировало стадию `CODING` для остальных задач.
**Последствия:** одиночные инфраструктурные падения больше не приводят к немедленному
повторному захвату той же задачи, а длинная петля останавливается вручную разбираемым
`BLOCKED`. Выбран `BLOCKED`, а не `FAILURE_ANALYSIS`, потому что при таких провалах нет
результата пайплайна для анализа, и переход через `FAILURE_ANALYSIS` может вернуть
задачу обратно в `CODING`. Приоритетная очередь PROGRAMMER, worktree-сериализация по
сервису, `releaseStaleClaudeClaims`, `reapOrphanRunningRuns` и clock-guard не меняются.
