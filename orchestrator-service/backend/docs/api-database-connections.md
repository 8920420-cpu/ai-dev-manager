# Контракт `/api/database-connections` (orchestrator-service)

DATABASE-CONNECTIONS-001 (ORCHESTRATOR-P1.4). Единая пользовательская модель
подключений к БД для FRONTEND-P1.3. **Нет** категорий «основная»/«дополнительная».
Внутреннее инфраструктурное подключение оркестратора (config/db.settings.json)
здесь не присутствует и не выдаётся за доступную проекту БД. `secret` (пароль)
никогда не возвращается; в ошибках/логах нет строки подключения и пароля.

---

## DTO подключения

```json
{
  "id": "uuid",
  "name": "Каталог-БД",
  "dbmsType": "postgres",
  "host": "127.0.0.1",
  "port": 5432,
  "database": "catalog",
  "user": "app",
  "sslMode": "disable",
  "hasSecret": true,
  "createdAt": "…",
  "updatedAt": "…"
}
```

## `GET /api/database-connections`
`{ "connections": [ DTO, … ] }`.

## `GET /api/database-connections/:id`
DTO. `404 database_connection_not_found`.

## `POST /api/database-connections`
Тело: `{ name*, dbmsType?, host, port, database, user, password, sslMode }`.
`password` пишется в server-only `secret`. `201` + DTO.
`422 database_connection_name_required`, `422 database_connection_unsupported_dbms`.

## `PUT /api/database-connections/:id`
Частичное обновление. **Без нового `password` существующий секрет сохраняется**
(пустой/отсутствующий `password` не затирает). `200` + DTO.

## `DELETE /api/database-connections/:id`
Запрещено, если подключение используется проектами:

```json
// 409 database_connection_in_use
{ "ok": false, "code": "database_connection_in_use", "count": 2,
  "dependents": [ { "id": "p-uuid", "code": "PS", "name": "ПС" } ] }
```
Каскадного обнуления ссылок проектов нет. Иначе `200 { "deleted": true }`.

## `POST /api/database-connections/:id/test`
Проверка соединения по сохранённым реквизитам. Ничего не пишет.
`{ "connected": true, "error": null }` или `{ "connected": false, "error": "db_error:28P01" }`.
`error` — безопасный класс ошибки без реквизитов (`authentication_failed`,
`host_unreachable`, `connection_refused`, `connection_timeout`, `db_error:<code>`).

---

## Ссылка проекта на БД

`projects.databaseId` = `database_connections.id` или `null` (проект без БД).
Правило при создании/обновлении проекта (поле `databaseId`):

- передан `id` → должен существовать (иначе `422 project_database_unknown`);
- передан `null`/`""` → проект без БД;
- **не передан** при создании: одно подключение → назначается по умолчанию;
  несколько → `422 project_database_selection_required`; ни одного → проект без БД.

## Миграция (применять только после подтверждения)

`db/migrations/0011_database_connections.sql` переименовывает
`additional_databases` → `database_connections`, добавляет `dbms_type` и
переводит `projects.database_ref = 'primary-postgres'` в `NULL` (инфраструктурное
подключение больше не доступная БД). Read-only аудит до применения:

```sql
SELECT count(*) FROM additional_databases;                 -- сколько подключений переедет
SELECT count(*) FROM projects WHERE database_ref = 'primary-postgres'; -- сколько проектов станут «без БД»
SELECT database_ref, count(*) FROM projects GROUP BY database_ref;     -- распределение ссылок
```

## Legacy (DEPRECATED, удаляются в INTEGRATION-P3.1)

`/api/additional-databases*`, `/api/databases`, `/api/db/test`, `/api/import/legacy`
(для БД) — переходные, заменены этим контрактом.
