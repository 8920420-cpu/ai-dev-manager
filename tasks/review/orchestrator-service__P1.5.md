---
id: ORCHESTRATOR-P1.5
status: review
service: ORCHESTRATOR
priority: P1
initiative: ROLE-CONFIGURATION-001
owner: orchestrator-service
depends_on: []
---

# P1.5 ROLE-CONFIGURATION-001 — хранение настроек роли и пропуск скрытых ролей

## Description

Расширить серверную модель роли: хранить краткое описание, рабочий промт, список подключённых skill-файлов и признак `hidden`. Скрытая роль остаётся в конфигурации проекта и истории, но не запускается: оркестратор автоматически переходит к следующей активной роли.

## Scope

- `orchestrator-service/backend/src/`, `orchestrator-service/backend/db/`, серверные API-документы и тесты.
- `roles/` и каталог доступных skill-файлов — только в части безопасного чтения и привязки существующих файлов.

## Pre-coding brief (готовит оркестратор)

- Каноническая идентичность роли определяется её `code`; `hidden` — глобальная настройка роли, а не удаление роли из этапов проекта.
- API возвращает и принимает как минимум: `code`, `name`, `description`, `prompt`, `skills`, `hidden`. `skills` содержит стабильные относительные пути/идентификаторы, а не произвольные пути файловой системы.
- Сервер отдаёт отдельный список доступных skill-файлов для диалога «Добавить». Разрешены только файлы внутри настроенного каталога skills; path traversal и произвольное чтение файлов запрещены.
- При выполнении задачи скрытая текущая роль пропускается без вызова AI/host-runner и без создания ложного успешного запуска. Переход идёт по каноническому маршруту к первой следующей активной роли. Если активных ролей далее нет, задача завершается штатно по правилам маршрута.
- Исторические записи, назначения ролей этапам и порядок ролей не удаляются. После снятия `hidden` роль снова участвует в новых переходах.
- Миграцию БД создать, но не запускать на пользовательской/внешней БД без отдельного явного подтверждения.

## Tasks

- Добавить хранение `description`, редактируемого prompt, `hidden` и связей роли с skill-файлами; обеспечить совместимые значения по умолчанию для существующих ролей.
- Реализовать API чтения и обновления карточки роли и API списка доступных skill-файлов с валидацией кода роли, размера полей, дублей skills и разрешённых путей.
- Загружать рабочий prompt и подключённые skills из сохранённой конфигурации роли; определить и протестировать порядок объединения prompt и skill-содержимого.
- Изменить переходы фонового runner и host-моста так, чтобы скрытые роли пропускались до первой активной роли во всех маршрутах, включая несколько скрытых ролей подряд.
- Обновить API-контракт и unit/contract-тесты.

## Acceptance

- После обновления роли повторный GET возвращает сохранённые описание, prompt, skills и `hidden`; произвольный путь вне каталога skills отклоняется.
- Роль с `hidden: true` остаётся доступна в настройках и назначениях этапов, но её исполнитель не вызывается.
- Для цепочки `active → hidden → hidden → active` следующий запуск получает последняя активная роль; за пропущенные роли нет agent/host run.
- Если скрыта последняя роль маршрута, задача достигает корректного конечного состояния без зацикливания.
- Снятие признака `hidden` возвращает роль в выполнение без восстановления удалённых данных.

## Orchestrator validation

- `npm test --prefix orchestrator-service/backend`
- Contract-тесты API роли: чтение, обновление, повторное чтение, неизвестный skill, path traversal.
- Тесты переходов: одна и несколько скрытых ролей подряд, скрытая последняя роль, повторная активация.

## Programmer note (READY_FOR_REVIEW)

Реализовано (роль PROGRAMMER, тесты не запускались — это делает оркестратор):

- **Миграция (создана, НЕ применена):** `orchestrator-service/backend/db/migrations/0009_role_configuration.sql` — `roles.prompt`, `roles.hidden` (default false), таблица `role_skills` (M:N, с `position`). Идемпотентна.
- **Новый модуль:** `src/roles.js` — `listRoles/getRole/updateRole`, `listAvailableSkills`, валидация skill-путей (traversal/абсолютные/расширение), чистые `mergePromptAndSkills`/`normalizeRoleUpdate`/`isSkillPathAllowed`/`resolveSkillPath`/`canonicalSkillId`, и `composeRoleSystemPrompt` (prompt-fallback + skills).
- **Пропуск скрытых ролей:** `src/rolePipeline.js` — чистый `fastForwardHiddenRoles`; `src/db.js` — фоновый `advanceHiddenRoleTasks` (вызывается в `advanceAutomatedTasks` до claim) + `r.hidden = false` в claim-запросах LLM/host/Claude.
- **Сборка промта роли:** `src/roleEngine.js` `runReasoningRole` теперь берёт system-промт из `composeRoleSystemPrompt` (сохранённый prompt или файловый fallback + skills).
- **API:** `src/server.js` — `GET /api/roles`, `GET|PUT /api/roles/:code`, `GET /api/skills`.
- **Тесты:** `test/roles.test.js` (чистые: пропуск ролей, валидация skills, порядок объединения, список skills).
- **Контракт:** `docs/api-roles.md` (для FRONTEND-P1.4 / INTEGRATION-P1.5).

Каталог skills конфигурируется `ORCHESTRATOR_SKILLS_DIR` (по умолчанию `skills/` в корне; отсутствие каталога → пустой список, не ошибка).

next_role: TASK_REVIEWER
