# Контракт `/api/projects/*` (orchestrator-service)

Зафиксированный контракт для frontend, pipeline-runner и scanner-service.
`:projectId` — UUID проекта **или** его `code`. Все ответы — JSON.
Если задан `ORCHESTRATOR_API_TOKEN`, требуется `Authorization: Bearer <token>`.

---

## PIPELINE-STAGE-CONFIG-001 — этапы пайплайна проекта

Признак Scanner — **только** код роли `SCANNER` (не имя этапа/роли).
Отключённый этап (`enabled: false`) не удаляется и не меняет позицию;
его папка не очищается и восстанавливается при повторном включении.

### `GET /api/projects/:projectId/stages`

Читает сохранённые этапы. `enabled` всегда присутствует в ответе как явный
boolean (в БД колонка `NOT NULL DEFAULT true`).

```json
{
  "projectId": "f0e1...uuid",
  "stages": [
    {
      "id": "stage-uuid-1",
      "name": "Разработка",
      "enabled": true,
      "position": 0,
      "roleIds": ["role-uuid-prog"],
      "roleCodes": ["PROGRAMMER"]
    },
    {
      "id": "stage-uuid-2",
      "name": "Тесты",
      "enabled": false,
      "position": 1,
      "roleIds": ["role-uuid-pipe"],
      "roleCodes": ["PIPELINE_SERVICE"]
    },
    {
      "id": "stage-uuid-3",
      "name": "Scanner",
      "enabled": true,
      "position": 2,
      "roleIds": ["role-uuid-scanner"],
      "roleCodes": ["SCANNER"],
      "scanner": { "watchDirectory": "K:\\projects\\my-service" }
    }
  ]
}
```

- `scanner` присутствует у Scanner-этапа (роль `SCANNER`). Папка показывается
  и для не-Scanner-этапа, если была сохранена ранее (чтобы не потерять её при
  временной смене роли).

### `PUT /api/projects/:projectId/stages`

Сохраняет (создаёт/обновляет) **полный упорядоченный** список этапов. Клиент
присылает все этапы, включая отключённые с их папкой. Порядок берётся из
позиции в массиве. Роли можно задавать `roleCodes` (канонические коды) и/или
`roleIds` (UUID ролей БД); несопоставимые ссылки игнорируются.

Поле `enabled` **обязательно** и принимает только boolean `true` или `false`.
Сервер больше не поддерживает старый контракт `enabled` отсутствует = включён.
При пропущенном или не-boolean значении `PUT` возвращает `422` с кодом
`stage_enabled_required`.

Тело запроса:

```json
{
  "stages": [
    { "name": "Разработка", "enabled": true, "roleCodes": ["PROGRAMMER"] },
    { "name": "Тесты", "enabled": false, "roleCodes": ["PIPELINE_SERVICE"] },
    {
      "name": "Scanner",
      "enabled": true,
      "roleCodes": ["SCANNER"],
      "scanner": { "watchDirectory": "K:\\projects\\my-service" }
    }
  ]
}
```

Успех `200` — тот же контракт, что у `GET` (с присвоенными `id`/`position`).

#### Валидация (HTTP 422, стабильные коды, привязка к `stageId`)

Включённый этап с ролью `SCANNER` обязан иметь абсолютный `watchDirectory`.
Синтаксис абсолютного пути: Windows-диск (`K:\...`), UNC (`\\host\share`) или
POSIX (`/path`). Существование/доступность каталога проверяет scanner-service.

```json
{
  "ok": false,
  "error": "stage_validation_failed",
  "code": "stage_validation_failed",
  "errors": [
    { "stageId": "stage-uuid-3", "code": "scanner_watch_directory_required", "message": "…" }
  ]
}
```

Коды ошибок:

| code | условие |
| --- | --- |
| `scanner_watch_directory_required` | включённый Scanner без папки |
| `scanner_watch_directory_must_be_absolute` | путь не абсолютный |
| `scanner_stage_conflict` | более одного включённого этапа `SCANNER` (один watcher на проект) |
| `stage_name_required` | пустое имя этапа |

Статус запуска `SKIPPED` от клиента не принимается: API хранит только
конфигурацию (`enabled`), а `SKIPPED` формирует исполнитель пайплайна.

`404 project_not_found` — неизвестный проект.

---

## PROJECT-TASK-MONITOR-001 — статистика задач проекта

### `GET /api/projects/:projectId/task-statistics?limit=&offset=`

Read-only. Возвращает задачи только этого проекта. Длительности считаются
относительно единого серверного `generatedAt`. Активные растут, завершённые
зафиксированы. Недостающие отметки — `null` + `timingState`. Пагинация:
`limit` (по умолчанию 50, максимум 200), `offset` (≥0). Эндпоинт ничего не
изменяет; промты, payload событий, пути и секреты в ответ не входят.

```json
{
  "projectId": "f0e1...uuid",
  "generatedAt": "2026-06-22T10:00:00.000Z",
  "summary": {
    "total": 12,
    "active": 5,
    "completed": 4,
    "blocked": 1,
    "byStage": { "CODING": 3, "REVIEW": 2, "DONE": 4, "BLOCKED": 1, "TESTING": 2 },
    "averageCompletedDurationMs": 3600000
  },
  "pagination": { "limit": 50, "offset": 0, "total": 12 },
  "tasks": [
    {
      "id": "task-uuid",
      "title": "Добавить печатную форму счёта",
      "service": "Catalog_Service",
      "status": "CODING",
      "stageCode": "CODING",
      "stageName": "Разработка",
      "createdAt": "2026-06-22T09:00:00.000Z",
      "stageStartedAt": "2026-06-22T09:30:00.000Z",
      "completedAt": null,
      "stageDurationMs": 1800000,
      "totalDurationMs": 3600000,
      "timingState": "active"
    }
  ]
}
```

- `stageCode` стабилен и соответствует `task_status` (этап не вычисляется по
  тексту/имени агента). `timingState`: `active` | `completed` |
  `missing_completion` | `missing_created`.
- Сортировка: активные → заблокированные → терминальные, затем по времени
  изменения. Повторный вход в этап использует последний непрерывный интервал;
  `totalDurationMs` — сквозной (включая ожидания и возвраты на доработку).
- `404 project_not_found` — неизвестный проект.
