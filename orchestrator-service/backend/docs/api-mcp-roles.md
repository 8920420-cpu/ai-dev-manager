# Контракт `/api/mcp-roles/*` (orchestrator-service)

MCP-ROLES-001. Раздел «MCP роли» — роли, которые можно использовать через MCP
(Model Context Protocol). Все ответы — JSON. Если задан `ORCHESTRATOR_API_TOKEN`,
требуется `Authorization: Bearer <token>`.

MCP-роль — обычная строка таблицы `roles` с флагом `is_mcp_role = true`
(миграция `0041_mcp_roles.sql`). Отдельная таблица не заводится: это даёт единый
CRUD и совместимость с историей/`agent_runs`. Пайплайновые роли (`is_mcp_role =
false`) в этот раздел не попадают и через `/api/mcp-roles/*` не редактируются и
не удаляются.

Каноническая идентичность роли — её `code` (уникальный, задаётся при создании и
далее не меняется).

---

## Модель карточки MCP-роли (DTO)

```json
{
  "code": "MCP_REVIEWER",
  "name": "MCP Reviewer",
  "description": "Роль ревью, доступная через MCP.",
  "prompt": "Ты — ревьюер. …",       // промт роли (пусто = не задан)
  "requirements": "Доступ на чтение репозитория; язык ответа — русский.",
  "isMcpRole": true
}
```

Поля:

- `code` — уникальный код роли. Формат: латинская буква, далее буквы/цифры/`._-`,
  до 64 символов (`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`).
- `name` — отображаемое имя (обязательно, ≤ 200).
- `description` — краткое описание (≤ 2000, `""` = не задано).
- `prompt` — промт роли (≤ 100000, `""` = не задан).
- `requirements` — требования к роли: доступы, данные, ограничения (≤ 20000,
  `""` = не задано).
- `isMcpRole` — всегда `true` для сущностей этого раздела.

## `GET /api/mcp-roles`

Список MCP-ролей.

```json
{ "roles": [ { "code": "MCP_REVIEWER", "name": "MCP Reviewer", "description": "…", "prompt": "…", "requirements": "…", "isMcpRole": true } ] }
```

## `POST /api/mcp-roles`

Создать MCP-роль. Тело: `{ code, name, description?, prompt?, requirements? }`.
Ответ — `201` с карточкой роли.

- `409 mcp_role_code_exists` — роль с таким `code` уже существует.
- `422 mcp_role_code_required` / `mcp_role_code_invalid` / `mcp_role_name_required`
  и лимитные `*_too_long` — ошибки валидации.

## `GET /api/mcp-roles/:code`

Карточка одной MCP-роли. `404 mcp_role_not_found`, если роли нет или она не
является MCP-ролью.

## `PUT /api/mcp-roles/:code`

Частичное обновление: меняются только переданные поля
(`name` / `description` / `prompt` / `requirements`). `code` роли не меняется.
Ответ — актуальная карточка. `404 mcp_role_not_found`, если роль не найдена
среди MCP-ролей.

## `DELETE /api/mcp-roles/:code`

Удалить MCP-роль. Ответ — `{ "deleted": true }`. `404 mcp_role_not_found`, если
роль не найдена среди MCP-ролей (пайплайновую роль этим маршрутом не удалить).

---

## Использование через MCP

MCP-сервис (`mcp-service`) предоставляет read-only инструменты поверх этого API:

- `orchestrator_list_mcp_roles` → `GET /api/mcp-roles`;
- `orchestrator_get_mcp_role` (`roleCode`) → `GET /api/mcp-roles/:code` — отдаёт
  карточку роли вместе с `prompt` и `requirements`, чтобы MCP-клиент мог применить
  роль (использовать её промт и учесть требования).
