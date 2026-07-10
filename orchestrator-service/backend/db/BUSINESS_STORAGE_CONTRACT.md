# BUSINESS_STORAGE_CONTRACT — LEGACY-BUSINESS-STORAGE-API-001

Канонический контракт серверного хранения бизнес-данных, ранее лежавших в
localStorage фронтенда. Источник истины — orchestrator_db (миграция `0008`).
Секреты (пароли доп. БД, токены коннекторов) НИКОГДА не возвращаются клиенту.

Признак роли — канонический **код** (как в `stages.js`), не отображаемое имя.

## Сущности и таблицы

- Проект: `projects` (+`status`, `database_ref`, `updated_at`) + этапы в
  `project_stages`/`project_stage_roles` (уже есть, см. `stages.js`).
- Доп. БД: `additional_databases` (secret — server-only).
- Назначение «reasoning-роль→коннектор»: `role_connectors` (role_code → connectors.id).

## Формат проекта (rich)

```jsonc
{
  "id": "uuid",
  "code": "MY_PROJECT",
  "name": "Мой проект",
  "path": "K:\\projects\\my",          // = projects.root_path
  "status": "active",                   // active|paused|draft|archived
  "databaseId": "primary-postgres",     // = projects.database_ref (или uuid доп.БД), может быть null
  "stages": [ /* контракт этапа из stages.js: id,name,enabled,position,roleIds,roleCodes,scanner? */ ],
  "roles": [ { "id": "uuid", "code": "PROGRAMMER", "name": "Programmer" } ], // ГЛОБАЛЬНЫЕ роли (roles)
  "createdAt": "ISO",
  "updatedAt": "ISO"                    // токен optimistic concurrency
}
```

`roles` — глобальные роли пайплайна (таблица `roles`), единый источник истины.
Этапы ссылаются на роли по коду (см. `resolveStageRoles` в `stages.js`).

## Endpoints проектов

- `GET /api/projects` → `{ projects: RichProject[] }` (без тяжёлых данных задач).
  Совместимость: каждый элемент содержит и `path`, и `rootPath` (алиас) — чтобы
  существующий `dbProjectsApi` не сломался.
- `POST /api/projects` → создать/идемпотентно привязать по `path`.
  Тело: `{ name, path, status?, databaseId?, stages?, roles? }`.
  Если проект с таким `root_path` уже есть — обновить переданные поля и вернуть его
  (это сохраняет идемпотентную «регистрацию по папке» из монитора задач).
  Возврат: `RichProject` (со всеми полями, включая `id`).
- `GET /api/projects/:id` → `RichProject`. `:id` — uuid ИЛИ code ИЛИ root_path.
- `PUT /api/projects/:id` → обновить `{ name?, path?, status?, databaseId?, stages?, roles? }`.
  Optimistic concurrency: тело может содержать `updatedAt` (или заголовок `If-Match`).
  Если переданный `updatedAt` не совпадает с текущим в БД → HTTP 409
  `{ code: "project_conflict" }`. Возврат: `RichProject`.
- `PATCH /api/projects/:id/status` → `{ status }`. Возврат: `RichProject`.
- `GET /api/projects/:id/route-health` → структурированный health-check маршрута проекта:
  `{ projectId, problems:[{ code, severity, stageId, stageName, roleCode, message, recommendation }], summary:{ error, warning, total, ok } }`.
  Проверки: роль этапа без исполнителя, обычный enabled `kind=stage` без `task_status`,
  host-роль с LLM-коннектором, reasoning-роль без включённого коннектора, непарные `fork`/`join`.
  Graph-ноды `fork`/`join`/`condition` не считаются обычными этапами без статуса.
- `DELETE /api/projects/:id` → `{ deleted: true }` (CASCADE удаляет этапы).
- Stages в create/update: если `stages` переданы — сохранить через ту же логику,
  что и `saveProjectStages` (валидация enabled+SCANNER+watchDirectory, коды ошибок
  привязаны к stageId, HTTP 422 при ошибке). Существующие `GET/PUT /api/projects/:id/stages`
  СОХРАНИТЬ как есть.

Машинные коды ошибок проектов: `project_path_required`, `project_not_found`,
`project_conflict`, `project_invalid_status`.

## Endpoints доп. БД (`additional_databases`)

Контракт записи (БЕЗ секрета):
```jsonc
{ "id":"uuid", "name":"", "host":"", "port":5432, "database":"", "user":"", "sslMode":"disable", "hasSecret":true, "createdAt":"ISO", "updatedAt":"ISO" }
```
- `GET /api/additional-databases` → `{ databases: AdditionalDb[] }` (никогда не отдаёт `secret`/`password`).
- `POST /api/additional-databases` → создать. Тело: поля выше + `password?` (пишется в `secret`).
- `PUT /api/additional-databases/:id` → обновить. Пустой/отсутствующий `password` = не менять секрет.
- `DELETE /api/additional-databases/:id` → `{ deleted: true }`.
Коды ошибок: `additional_database_not_found`, `additional_database_name_required`.

## Endpoints назначений «роль→коннектор» (`role_connectors`)

```jsonc
{ "roleCode":"ARCHITECT", "connectorId":"uuid|null", "updatedAt":"ISO" }
```
- `GET /api/role-connectors` → `{ assignments: RoleConnector[] }`.
- `PUT /api/role-connectors` → массовое сохранение `{ assignments:[{roleCode, connectorId|null}] }`.
  `connectorId: null` снимает назначение и разрешён для любой роли. Ненулевой `connectorId`
  разрешён только reasoning-ролям: `TASK_INTAKE_OFFICER`, `ARCHITECT`, `DECOMPOSER`,
  `TASK_REVIEWER`, `FAILURE_ANALYST`, `DOCUMENTATION_AUDITOR`, `DOCUMENTATION_KEEPER`.
  Возврат: актуальный список.
Коды ошибок: `role_connector_invalid_role`, `role_connector_invalid_connector`,
`role_connector_role_not_reasoning`.

## Endpoint идемпотентного импорта legacy-данных

- `POST /api/import/legacy` — перенос данных из localStorage.
  Тело: `{ migrationKey: string, dryRun?: boolean, projects?:[...], additionalDatabases?:[...], roleConnectors?:[...] }`.
  - `dryRun: true` → предпросмотр: ничего не пишет, возвращает план `{ create:[...], conflict:[...], skip:[...] }`.
  - Идемпотентность по `migrationKey` + естественным ключам (проект по `path`, доп. БД по `name+host+database`,
    назначение по `roleCode`). Повторный импорт НЕ дублирует и НЕ перезаписывает существующее молча
    (конфликт → попадает в `conflict`, не пишется).
  - Секреты НЕ принимаются из импорта (пароли не переносятся).
  Возврат: `{ migrationKey, dryRun, created:{...counts}, conflicts:[...], skipped:[...] }`.

## Тестирование (без живой БД)

Чистые функции (валидация статуса, redaction секрета, маппинг строки→контракт,
проверка конфликта по updatedAt, дедуп импорта) покрываются `node:test` по образцу
`test/databases.test.js` (инъекция зависимостей, без подключения к БД).
