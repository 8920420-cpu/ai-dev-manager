# PROJECT_MAP.md

> Полная карта репозитория **ai-dev-manager** (AI Orchestrator).
> Позволяет новому ИИ-агенту понять структуру без чтения всего кода.
> Поддерживается автоматически после каждой значимой задачи.

## Дерево проекта

```text
ai-dev-manager/
├── roles/                  # Промты ролей оркестратора (Markdown)
│   ├── failure-analyst.md
│   ├── tester.md
│   ├── architect.md
│   ├── decomposer.md
│   ├── programmer.md
│   ├── scanner.md
│   ├── reviewer.md
│   ├── documentation-auditor.md
│   ├── documentation-keeper.md
│   └── git-integrator.md
├── pipeline-runner/        # Универсальный запускатель этапов CI/CD (Node.js)
│   ├── src/
│   ├── bin/pipeline-runner.js
│   └── README.md
├── scanner-service/        # Файловый мост Claude Code → Orchestrator
│   ├── src/TaskScanner.js
│   ├── bin/scanner-service.js
│   └── Dockerfile
├── runtime/
│   └── claude-tasks.json   # Документ обмена задачами с Claude Code
├── tester-service/         # Микросервис роли «Тестировщик» (HTTP, Node.js)
│   ├── src/
│   ├── bin/tester-service.js
│   ├── Dockerfile
│   └── README.md
├── orchestrator-service/   # Микросервис: backend (Node+pg) + frontend (GUI)
│   ├── backend/
│   │   ├── bin/server.js   # автосоздание БД + HTTP API
│   │   ├── src/            # config.js, db.js, server.js
│   │   └── db/             # migrations/, seed/, DATA_MODEL.md
│   ├── frontend/           # index.html, styles.css, app.js (экран настроек БД)
│   └── Dockerfile
├── docs/                   # Документация-источник контекста (этот каталог)
├── dist/                   # Сборка фронтенда
├── docker-compose.yml      # Сервис ai-dev-manager (порт 4186)
├── Dockerfile
├── nginx.conf
└── .pipeline.json          # Конфиг pipeline для самого проекта
```

---

## Микросервисы и компоненты

### pipeline-runner
- **Назначение:** запуск этапов CI/CD (test/lint/build/deploy/smoke). Стадии
  задаются `.pipeline.json` ЛИБО конвенцией по пути сервиса. В сервисном режиме
  (`runServicePipeline`) при отсутствии `.pipeline.json` движок сам строит стадии
  по конвенции монорепо (`ConventionConfigBuilder`): детект стека (go.mod →
  `go test ./...`; package.json со скриптом test → `npm test`; иначе test SKIPPED)
  и подсистемы (ближайший вверх `docker-compose.yml` → build/deploy `docker compose
  build`/`up -d`; smoke по healthcheck compose). Локальный `.pipeline.json` —
  необязательный override (целиком или постадийно через `extendsConvention`).
- **Технологии:** Node.js ≥ 18.
- **Путь:** `pipeline-runner/`
- **Зависимости:** нет (используется tester-service как `file:../pipeline-runner`).
- **Точка входа:** `bin/pipeline-runner.js` / `src/index.js` (`runPipeline`).

### tester-service
- **Назначение:** микросервис роли «Тестировщик». Запускает Pipeline Runner и
  возвращает результат оркестратору. Сам код/ошибки **не** анализирует.
- **Технологии:** Node.js ≥ 18, HTTP.
- **Путь:** `tester-service/`
- **Зависимости:** `pipeline-runner`.
- **Точка входа:** `bin/tester-service.js` (HTTP на `$TESTER_PORT`, по умолчанию 4187).

### ai-dev-manager (web)
- **Назначение:** фронтенд/панель оркестратора (Vite+React SPA, `src/` → `dist/`).
- **Технологии:** статика за nginx, Docker.
- **Путь:** корень + `dist/`, `nginx.conf`.
- **Точка входа:** контейнер `ai-dev-manager`, порт 4186.
- **Виджет «Обратная связь»** (ORCH-FEEDBACK-WIDGET-001, коммит `8cbc0aa`):
  плавающая кнопка на всех страницах SPA — `src/App.tsx` подключает
  `src/features/feedback/FeedbackWidget.tsx` (диалог: категория → текст +
  чекбокс скриншота → проверка → отправка → номер заявки). Буфер JS-ошибок
  (`window.onerror`/`unhandledrejection`) — `src/features/feedback/jsErrorBuffer.ts`;
  скриншот через `html2canvas` ленивым импортом —
  `src/features/feedback/captureScreenshot.ts`; типы — `src/types/feedback.ts`;
  same-origin клиент — `src/api/feedbackApi.ts` (см. API_MAP.md). Бэкенд приёма
  реализован (FEEDBACK-WIDGET-001): `orchestrator-service/backend/src/feedback.js`
  обслуживает `POST /api/feedback`, `POST /api/feedback/screenshot` и
  `GET /api/feedback/screenshot/:id` (роуты в `server.js`), переиспользуя
  `acceptIntakeReport` через интеграцию `orchestrator-ui`. Новая npm-зависимость —
  `html2canvas` (`package.json`).

### orchestrator-db
- **Назначение:** единый источник истины оркестрации (задачи, статусы, роли,
  агенты, промты, запуски, блокировки, пайплайны, ревью, история).
- **Технологии:** PostgreSQL 16 (контейнер `infra-postgres-1`), БД `orchestrator_db`.
- **Путь:** `orchestrator-service/backend/db/`. Описание — [DATA_MODEL.md](../orchestrator-service/backend/db/DATA_MODEL.md).

---

## Роли оркестратора (промты)

| Роль | Файл | Что делает |
|------|------|-----------|
| Architect | `roles/architect.md` | проектирует решение и критерии приёмки |
| Decomposer | `roles/decomposer.md` | разбивает решение на проверяемые задачи |
| Programmer | `roles/programmer.md` | реализует одну задачу |
| Scanner | `roles/scanner.md` | отслеживает завершение в task document и запускает следующий этап |
| Task Reviewer | `roles/reviewer.md` | проверяет diff до pipeline |
| Pipeline Service | `roles/tester.md` | запускает pipeline, возвращает сырой результат |
| Failure Analyst | `roles/failure-analyst.md` | превращает лог падения в задачу Programmer |
| Documentation Auditor | `roles/documentation-auditor.md` | определяет необходимость обновления документов |
| Documentation Keeper | `roles/documentation-keeper.md` | обновляет подтверждённо устаревшие документы |
| Git Integrator | `roles/git-integrator.md` | создаёт итоговый commit |

---

## Внешняя инфраструктура (Docker)

| Сервис | Контейнер | Порт |
|--------|-----------|------|
| PostgreSQL 16 | `infra-postgres-1` | 127.0.0.1:5432 |
| pgAdmin | `infra-pgadmin-1` | 5058 |
| Redis | `infra-redis-1` | 6379 |
| MinIO | `infra-minio-1` | 9001 |
| ai-dev-manager | `ai-dev-manager` | 4186 |
