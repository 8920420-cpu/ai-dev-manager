# Контракт `/api/roles/*` и `/api/skills` (orchestrator-service)

ROLE-CONFIGURATION-001 (ORCHESTRATOR-P1.5). Зафиксированный контракт для
frontend (FRONTEND-P1.4) и E2E (INTEGRATION-P1.5). Все ответы — JSON.
Если задан `ORCHESTRATOR_API_TOKEN`, требуется `Authorization: Bearer <token>`.

Каноническая идентичность роли — её `code`. `name`/`code` через этот API не
меняются. `hidden` — **глобальная** настройка роли: скрытая роль остаётся в
конфигурации, истории и этапах проекта, но её исполнитель не вызывается —
оркестратор переходит к первой следующей активной роли.

---

## Модель карточки роли (DTO)

```json
{
  "code": "ARCHITECT",
  "name": "Architect",
  "description": "Проектирует решение и критерии приёмки.",
  "prompt": "",                 // рабочий промт; "" = используется файловый roles/<role>.md
  "hidden": false,
  "skills": ["group/a.md", "b.md"]   // стабильные относительные id внутри каталога skills
}
```

`skills` — упорядоченный список стабильных относительных id (POSIX-слэши) строго
внутри настроенного каталога skills (`ORCHESTRATOR_SKILLS_DIR`, по умолчанию
`skills/` в корне). Произвольные пути ФС и path traversal запрещены.

## `GET /api/roles`

Список карточек всех ролей.

```json
{ "roles": [ { "code": "ARCHITECT", "name": "Architect", "description": "…", "prompt": "", "hidden": false, "skills": [] } ] }
```

## `GET /api/roles/:code`

Одна карточка роли. `404 role_not_found`, если роли нет.

## `PUT /api/roles/:code`

Частичное обновление карточки. Тело — любое подмножество полей:

```json
{ "description": "…", "prompt": "…", "hidden": true, "skills": ["a.md"] }
```

Правила:

- меняются только переданные поля; `code`/`name` неизменны;
- `prompt: ""` (или пробелы) сохраняется как `null` → файловый промт-fallback;
- `skills` заменяется целиком (replace-set), порядок сохраняется;
- дубли `skills` запрещены (`422 role_skill_duplicate`);
- неизвестный skill — `422 role_skill_unknown`; путь вне каталога/traversal — `422 role_skill_invalid_path`;
- `hidden` только boolean (`422 role_hidden_must_be_boolean`);
- лимиты: description ≤ 2000, prompt ≤ 100000, skills ≤ 50, путь ≤ 512.

Ответ — актуальная карточка роли (как `GET /api/roles/:code`).

## `GET /api/skills`

Список доступных skill-файлов внутри настроенного каталога (рекурсивно,
`.md`/`.txt`, dotfiles игнорируются). Несуществующий каталог → пустой список.

```json
{ "skills": [ { "id": "group/a.md", "name": "a.md" }, { "id": "b.md", "name": "b.md" } ] }
```

## `POST /api/skills`

Загрузка skill-файла с ПК пользователя в каталог skills сервера. Тело:

```json
{ "name": "my-skill.md", "content": "# Skill\n…" }
```

- `name` приводится к одному базовому имени файла (каталоги и `..` отбрасываются);
- расширение только `.md`/`.txt` (`422 skill_extension_invalid`);
- пустое содержимое запрещено (`422 skill_content_empty`), лимит — 500000 символов
  (`422 skill_content_too_long`);
- недопустимое имя → `422 skill_name_invalid` / `skill_name_too_long`;
- файл с тем же именем перезаписывается; каталог создаётся при отсутствии.

Ответ `201` — стабильный id/name загруженного файла (как в `GET /api/skills`),
готовый для подключения к роли через `PUT /api/roles/:code`:

```json
{ "id": "my-skill.md", "name": "my-skill.md" }
```

---

## Объединение промта и skills

Итоговый system-промт активной роли = рабочий `prompt` (или файловый fallback
`roles/<role>.md`, если `prompt` пуст) + содержимое подключённых skills в
порядке `skills`. Каждый skill добавляется под заголовком `# Skill: <id>`.
Порядок зафиксирован и покрыт юнит-тестом (`mergePromptAndSkills`).

## Пропуск скрытых ролей

Перед каждым запуском фоновый runner переводит задачи, чья текущая роль
`hidden`, к первой следующей активной роли (`fastForwardHiddenRoles`), не
вызывая исполнителя. Поддержаны несколько скрытых ролей подряд и скрытая
последняя роль (задача штатно достигает `DONE`). Claim-запросы host/Claude/LLM
ролей исключают `hidden`-роли, поэтому за пропущенную роль не создаётся
agent/host run.
