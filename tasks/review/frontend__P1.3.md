---
id: FRONTEND-P1.3
status: review
service: FRONTEND
priority: P1
initiative: DATABASE-CONNECTIONS-UI-001
owner: frontend
depends_on: ["tasks/orchestrator-service.md → P1.4; единый API-контракт должен быть зафиксирован до реализации"]
---

# P1.3 DATABASE-CONNECTIONS-UI-001 — единый экран подключений к базам данных

## Description

единый экран подключений к базам данных

Initiative: `DATABASE-CONNECTIONS-001`
Owner: `frontend`

## Scope

- `src/features/settings/`, `src/features/projects/StepDatabase*`, `src/api/databasesApi*`, связанные frontend-типы, стили и тесты.

## Pre-coding brief (готовит оркестратор)

Подтверждённое продуктовое правило: в интерфейсе нет «основной», «дополнительных» или иных категорий баз данных. Любая доступная проекту база появляется только как отдельное подключение, созданное пользователем через кнопку «Подключить».

- Канонические endpoint, DTO, коды ошибок и правило проекта без БД берутся только из результата orchestrator P1.4; Programmer их не проектирует.
- Модальные окна подчиняются общему правилу `TASKS.md`: закрываются только явной видимой кнопкой.

## Tasks

- Удалить с экрана «Базы данных» встроенную форму «PostgreSQL — Параметры подключения оркестратора к базе данных PostgreSQL», секцию «Дополнительные базы данных» и секцию «Перенос локальных данных».
- Оставить единый список подключённых баз и основное действие «Подключить». По нажатию открывать форму подключения БД; PostgreSQL поддержать как тип подключения, а не как отдельную системную секцию экрана.
- После создания показывать каждое подключение отдельной плашкой/карточкой в общем списке без признаков «основная» или «дополнительная». На карточке показывать понятное имя, тип СУБД, адрес/имя БД и актуальный статус подключения, не раскрывая пароль.
- Предусмотреть на карточке действия проверки, редактирования и удаления подключения. Ошибка одной БД не должна скрывать остальные карточки или блокировать создание нового подключения.
- Перевести загрузку, создание, изменение и удаление на единый API подключений; удалить из UI, типов и пользовательских текстов термины и ветвления `primary`/`additional`, а также обращения к legacy-import для БД.
- В мастере создания и редактирования проекта загружать тот же единый список. Если доступно одно подключение, выбирать его автоматически и сохранять как подключение проекта по умолчанию; если подключений несколько — требовать явный выбор; если нет ни одного — показать переход на экран «Базы данных» к кнопке «Подключить».
- При удалении подключения, которое используется проектами, показывать серверную информацию о конфликте и не сбрасывать ссылки проектов молча.
- Обеспечить keyboard navigation, видимый focus, доступные названия кнопок карточки, состояния загрузки/пустого списка/ошибки и адаптивное отображение карточек.

## Acceptance

- На экране отсутствуют три прежние формы/секции; пользователь видит единый список карточек и кнопку «Подключить».
- Созданная через кнопку БД появляется карточкой, переживает перезагрузку страницы и доступна для выбора в проекте; секрет подключения не возвращается и не отображается.
- При одной БД новый проект получает её автоматически без дополнительного выбора; при двух и более БД пользователь выбирает одну явно.
- Проверка, редактирование, удаление, конфликт удаления используемой БД, пустое состояние и ошибки API покрыты component/contract-тестами; production build проходит.

## Orchestrator validation

- `npm test -- --run`
- `npm run typecheck`
- `npm run build`
- Contract/E2E-проверка с orchestrator P1.4: 0/1/2 подключения, redaction секрета и конфликт удаления используемой БД.

## Programmer note (READY_FOR_REVIEW)

next_role: TASK_REVIEWER

### Изменённые / созданные файлы
- `src/types/settings.ts` — новая единая модель `DbConnection` (+ `DbmsType`, `DBMS_LABEL`, `DbConnectionTestResult`, `DbConnectionDependent`); удалены legacy-типы `DatabaseConnection`/`ConnectedDatabase`.
- `src/api/databaseConnectionsApi.ts` (новый) — единый клиент `/api/database-connections` (list/get/create/update/remove/test), `DbConnectionInput`, `DbConnectionInUseError` (409 + dependents), `isDraftConnectionId`, `makeDraft`. Пустой пароль не отправляется.
- `src/api/http.ts` — `ApiError` теперь несёт распарсенное `body` (нужно для структурного 409 in_use).
- `src/features/settings/DatabaseConnectionsSection.tsx` + `.module.css` (новые) — единый список карточек + кнопка «Подключить»; loading/empty/error с повтором; ошибка одной БД не блокирует остальные.
- `src/features/settings/DbConnectionCard.tsx` + `.module.css` (новые) — карточка: имя, тип СУБД, адрес/БД/пользователь, статус проверки, действия «Проверить/Изменить/Удалить», конфликт удаления (зависимые проекты). Секрет не показывается.
- `src/features/settings/DbConnectionFormModal.tsx` + `.module.css` (новые) — форма create/edit; PostgreSQL как тип подключения; пароль только на запись (пустой при edit = не менять); закрытие только кнопкой + ConfirmDialog.
- `src/features/settings/DatabasesPage.tsx` — теперь только `DatabaseConnectionsSection` (три прежние секции убраны).
- `src/features/projects/StepDatabase.tsx` — единый список подключений; правило 0/1/несколько (одно → авто-выбор, несколько → явный выбор, ноль → подсказка перейти на «Базы данных»); сброс несуществующего сохранённого id.
- `src/types/project.ts`, `src/features/projects/wizardState.ts` — комментарии обновлены под единую модель (databaseId = database_connections.id или без БД).

### Удалённые файлы (legacy)
- `src/features/settings/PostgresSection.tsx`, `DatabasesSection.tsx`, `ConnectedDatabasesSection.tsx`, `LegacyImportSection.tsx`.
- `src/api/databasesApi.ts` (+ test), `src/api/legacyImportApi.ts` (+ test).
- Удалены неиспользуемые legacy-стили из `settings.module.css` (dbList/dbCard/pg*/importPlan).

### Тесты (как код, не запускались)
- `src/api/databaseConnectionsApi.test.ts` (новый) — list без секрета, password при create/update, test endpoint, 409 → DbConnectionInUseError с dependents, makeDraft.
- `src/features/settings/DbConnectionCard.test.tsx` (новый) — секрет не показан, проверка соединения (безопасный класс ошибки), удаление успех/конфликт.
- `src/features/settings/DatabaseConnectionsSection.test.tsx` (новый) — нет прежних секций/терминов, единый список + «Подключить», empty/error+повтор, открытие формы.
- `src/features/projects/StepDatabase.test.tsx` (новый) — правило 0/1/несколько, сброс stale-id.

### Ключевые решения
- Термины primary/additional полностью убраны из UI, типов и текстов; `PRIMARY_DB_ID`/`SelectableDatabase`/`listSelectable` удалены вместе с `databasesApi`.
- 409-конфликт удаления используется буквально из контракта (`count` + `dependents`); ссылки проектов не обнуляются — карточка показывает Callout со списком проектов.
- `ApiError.body` добавлен в общий http-слой, чтобы структурированные коды ошибок (не только текст) были доступны API-клиентам.
- StepDatabase: авто-выбор строго при одном подключении; при нескольких — пустой плейсхолдер «— не выбрано —», что соответствует серверному `project_database_selection_required`.

### Риски / блокеры
- `settingsApi.ts` (старый PostgreSQL-конфиг оркестратора) больше не используется UI, но НЕ удалён (вне scope; внутреннее инфраструктурное подключение по контракту не выдаётся как доступная БД). Если нужно — отдельной задачей.
- Реальные ответы backend `/api/database-connections` вживую не проверялись — только по зафиксированному контракту api-database-connections.md.
- Build/typecheck/тесты по инструкции НЕ запускались. Изменение `ApiError` (добавлен необязательный аргумент/поле `body`) обратносовместимо.
