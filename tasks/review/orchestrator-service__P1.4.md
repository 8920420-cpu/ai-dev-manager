---
id: ORCHESTRATOR-P1.4
status: review
service: ORCHESTRATOR
priority: P1
initiative: DATABASE-CONNECTIONS-001
owner: orchestrator-service
depends_on: ["контракт этой задачи должен быть зафиксирован до `tasks/frontend.md` → P1.3; изменение схемы/данных требует отдельного подтверждения пользователя"]
---

# P1.4 DATABASE-CONNECTIONS-API-001 — единый контракт подключений к базам данных

## Description

Единый контракт подключений к базам данных.

## Scope

- backend API/хранилище подключений и проектов, миграция после подтверждения, backend-тесты, `docs/API_MAP.md` и `docs/DATABASE_MAP.md`; без frontend-файлов.

## Pre-coding brief (готовит оркестратор)

- Зафиксировать endpoint и DTO единого подключения, redaction/patch семантику секрета, коды validation/conflict и точное правило проекта при 0/1/нескольких БД.
- Подготовить read-only аудит текущих `additional_databases`, настроек PostgreSQL и `projects.database_ref`, а также план migration/rollback без выполнения записи.

## Tasks

- Свести системное PostgreSQL-подключение и сущность `additional_databases` в одну пользовательскую модель подключений БД. Во внешнем контракте не должно быть категорий «основная» и «дополнительная»; внутреннее инфраструктурное подключение оркестратора не выдавать за доступную проекту БД автоматически.
- Предоставить единый CRUD API списка подключений с проверкой соединения. Ответы list/read должны содержать стабильный ID, имя, тип СУБД, безопасные реквизиты и статус, но никогда не возвращать пароль.
- При обновлении без нового пароля сохранять существующий секрет; журналирование, ошибки и диагностические ответы не должны содержать строку подключения или пароль.
- Использовать стабильный ID единого подключения в ссылке проекта. Для создания/обновления проекта: одна доступная БД может быть назначена сервером по умолчанию, несколько требуют явного ID, отсутствие БД возвращает документированную ошибку или допускает проект без БД согласно зафиксированному контракту.
- Запрещать удаление подключения, используемого проектами, стабильной конфликтной ошибкой со списком/количеством зависимостей. Не применять каскадное обнуление ссылок.
- Подготовить безопасный переход существующих записей и `database_ref` на единую модель без дублирования. Любое изменение данных или схемы выполнять только после отдельного явного подтверждения пользователя по правилам корневого `TASKS.md`.
- Удалить или закрыть устаревшие публичные ветки API настроек PostgreSQL, дополнительных БД и импорта локальных БД после перехода всех потребителей. Обновление API- и database-карт передать документационным ролям оркестратора как `documentation_impact: REQUIRED`.

## Acceptance

- Все доступные проектам БД читаются и изменяются через один API и не различаются как «основные»/«дополнительные».
- CRUD, проверка соединения, redaction секрета, сохранение старого пароля при редактировании, запрет удаления используемого подключения и правило единственной БД покрыты contract/integration-тестами.
- Существующие проекты после подтверждённого перехода ссылаются на корректные подключения; в ответах и логах отсутствуют секреты.

## Orchestrator validation

- `npm test` в `orchestrator-service/backend`; тесты с реальной БД запускать только в подтверждённом безопасном окружении.
- До миграции проверить read-only audit/preview; migration и rollback запускать только после отдельного подтверждения пользователя.
- Выполнить contract/E2E с frontend P1.3 и проверить redaction в API, ошибках и логах.
- После успешной проверки запустить документационные роли для обновления `docs/API_MAP.md` и `docs/DATABASE_MAP.md`.

## Programmer note (READY_FOR_REVIEW)

Реализовано (роль PROGRAMMER, тесты не запускались):

- **Единый API:** `src/databaseConnections.js` + маршруты `GET/POST /api/database-connections`, `GET/PUT/DELETE /api/database-connections/:id`, `POST /api/database-connections/:id/test`. Без категорий primary/additional. secret — server-only (в ответах `hasSecret`). Update без password сохраняет старый секрет. Ошибки/тест не раскрывают реквизиты (`safeDbError`).
- **Запрет удаления используемого:** `DELETE` → `409 database_connection_in_use` со списком/количеством проектов; каскадного обнуления нет.
- **Правило выбора БД проекта:** чистый `resolveProjectDatabaseRef` (1 → по умолчанию, >1 → `422 project_database_selection_required`, 0 → без БД, неизвестный id → `422 project_database_unknown`); интегрирован в `projects.js` create/update.
- **Миграция (создана, НЕ применена; меняет схему И данные → ТРЕБУЕТСЯ подтверждение):** `db/migrations/0011_database_connections.sql` — rename `additional_databases`→`database_connections`, `+dbms_type`, `projects.database_ref='primary-postgres' → NULL`. Идемпотентна. Read-only аудит — в `docs/api-database-connections.md`.
- **Legacy (deprecated, не удалены — удаление в P3.1):** `additionalDatabases.js` перенаправлен на таблицу `database_connections`, чтобы `/api/additional-databases*` работали в переходный период. `/api/databases`, `/api/db/test`, `/api/import/legacy` оставлены deprecated.
- **Тесты:** `test/databaseConnections.test.js` (redaction, keep-secret, правило выбора БД). Существующие чистые тесты не затронуты.
- **Контракт-док:** `docs/api-database-connections.md` (для FRONTEND-P1.3).

ВНИМАНИЕ оркестратору/пользователю: миграции **0010** (PIPELINE_SERVICE local executor, меняет agents) и **0011** (database_connections, rename + database_ref) изменяют существующие данные — применять только после явного подтверждения и read-only аудита. Обновление `docs/API_MAP.md`/`docs/DATABASE_MAP.md` — документационным ролям (`documentation_impact: REQUIRED`).

next_role: TASK_REVIEWER
