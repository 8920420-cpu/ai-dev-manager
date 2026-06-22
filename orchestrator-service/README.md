# orchestrator-service

Микросервис AI Orchestrator: **бэкенд** (REST API) + раздача единого
React/Vite-фронтенда из корня репозитория (`src/` → `dist/`).

```
orchestrator-service/
├── backend/            # Node.js + pg
│   ├── bin/server.js   # точка входа (автосоздание БД + HTTP)
│   ├── src/
│   │   ├── config.js   # настройки подключения (файл/env)
│   │   ├── db.js       # ensureDatabase / runMigrations / seed / status
│   │   └── server.js   # REST API + раздача фронтенда (React-сборка)
│   ├── db/             # SQL-миграции, seed, DATA_MODEL.md
│   └── config/         # db.settings.json (создаётся через UI, в .gitignore)
└── Dockerfile          # один образ: backend собирает React (src/) и раздаёт его
```

Фронтенд в проекте **один** — React/Vite SPA в корне (`src/`). Dockerfile
собирает его и кладёт рядом с backend (`/app/frontend`); при локальном запуске
backend без Docker отдаётся корневой `dist/` (или каталог из `FRONTEND_DIR`).

## Что делает

1. **Автосоздание БД.** При старте (`AUTO_INIT≠false`) проверяет наличие БД
   `orchestrator_db` и **создаёт её, если нет**, затем накатывает миграции
   (идемпотентно, через таблицу `_schema_migrations`).
2. **Графический интерфейс.** На `/` — React-приложение (Проекты, Интеграции,
   Настройки → Роли/Базы данных). В Docker оно уже собрано в образ; при локальной
   разработке UI поднимается отдельно через Vite (`npm run dev` в корне, порт 4186,
   с прокси `/api` на backend).

## Запуск (на хосте)

```bash
# backend (API). UI в dev поднимается отдельно через Vite (npm run dev в корне).
cd orchestrator-service/backend
npm install
PORT=4186 npm start        # API: http://localhost:4186/api/...
```

Настройки сохраняются в `backend/config/db.settings.json`. По умолчанию:
`127.0.0.1:5432`, БД `orchestrator_db`, логин/пароль `postgres/postgres`.

## Запуск (Docker)

```bash
docker build -t orchestrator-service ./orchestrator-service
docker run -d --name orchestrator-service -p 4186:80 \
  -e PGHOST=host.docker.internal -e PGPORT=5432 \
  -e PGUSER=postgres -e PGPASSWORD=postgres -e PGDATABASE=orchestrator_db \
  orchestrator-service
```

## HTTP API

| Метод | Путь | Описание |
|-------|------|----------|
| GET  | `/health` | живость |
| GET  | `/api/settings` | текущие настройки |
| POST | `/api/settings` | сохранить настройки (`{host,port,user,password,database,adminDatabase}` или `{url}`) |
| POST | `/api/db/test` | проверить подключение |
| POST | `/api/db/init` | создать БД (если нет) + миграции |
| POST | `/api/db/seed` | загрузить примеры данных |
| GET  | `/api/db/status` | состояние БД (таблицы, миграции, счётчики) |
| GET  | `/api/databases` | список подключённых БД с живым статусом (без пароля) |

## Переменные окружения

`PORT` (4186), `HOST` (0.0.0.0), `AUTO_INIT` (true),
`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGADMIN_DB` — дефолты, если нет
сохранённого `db.settings.json`.

Схема БД — [backend/db/DATA_MODEL.md](backend/db/DATA_MODEL.md).
