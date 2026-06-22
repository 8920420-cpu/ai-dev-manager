---
id: FRONTEND-P2.1
status: review
service: FRONTEND
priority: P2
initiative: LEGACY-FRONTEND-LOCALSTORE-001
owner: frontend
depends_on: ["tasks/orchestrator-service.md → P2.1 (канонические API проектов, дополнительных БД и назначений ролей)"]
---

# P2.1 LEGACY-FRONTEND-LOCALSTORE-001 — удалить бизнес-хранилища frontend из localStorage

## Description

удалить бизнес-хранилища frontend из localStorage

> Выполнено вместе с серверной частью (orchestrator P2.1 + миграция `0008`, применена). `projectsApi`/`databasesApi`/`roleConnectionsApi` переведены на REST; `localStore.ts`/`createCollectionRepo`/`STORE_CHANGE_EVENT` удалены; Sidebar обновляется через событие `adm-projects-changed`; добавлены модуль и UI одноразового импорта (`legacyImportApi`/`LegacyImportSection`, без секретов, идемпотентно). Тесты vitest (65 всего) и build — зелёные.

Подтверждённая legacy-логика: `src/api/projectsApi.ts`, `databasesApi.ts` и `roleConnectionsApi.ts` используют `createCollectionRepo` из `localStore.ts`, хотя UI и другие сущности уже работают через `/api/*`.

## Scope

- Владелец исходников: `src/` (сборка в `dist/`).

## Pre-coding brief (готовит оркестратор)

- <готовит оркестратор до выдачи>

## Tasks

- Перевести `projectsApi` на канонический REST API, включая list/create/update/status/delete и серверные UUID; не генерировать `proj_*` в браузере.
- Перевести дополнительные подключения БД и назначения «роль → коннектор» на серверные API; секреты не переносить через localStorage или миграционный payload.
- Добавить одноразовый, явно запускаемый импорт допустимых локальных записей с предварительным просмотром, разрешением конфликтов и отметкой завершения. Не выполнять скрытый автоматический импорт или запись в БД без подтверждения пользователя.
- После миграционного окна удалить `createCollectionRepo`, `localStore`, `STORE_CHANGE_EVENT`, комментарии `BACKEND_REQUIRED` и все бизнес-ключи `adm:*` для проектов/БД/назначений ролей.
- Перевести `Sidebar`, формы проектов и настройки на обновление из API/cache invalidation, а не из browser storage event.
- Не удалять допустимые UI-настройки пользователя (`theme`, состояние сворачивания sidebar): они не являются серверными бизнес-данными.

## Acceptance

- В проекте нет импортов `createCollectionRepo` и бизнес-данные не читаются/не пишутся в localStorage.
- Два браузера видят одинаковые проекты, дополнительные БД и назначения ролей после обновления через API.
- Миграция не переносит пароли/токены, повторный запуск идемпотентен, а конфликт не перезаписывает серверные данные молча.
- Component/contract-тесты покрывают загрузку, мутации, конфликт импорта, отказ API и обновление Sidebar; production build проходит.

## Orchestrator validation

- <определяется оркестратором>
