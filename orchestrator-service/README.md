# orchestrator-service

Микросервис AI Orchestrator, разделённый на **бэкенд** и **фронтенд**.

```
orchestrator-service/
├── backend/            # Node.js + pg
│   ├── bin/server.js   # точка входа (автосоздание БД + HTTP)
│   ├── src/
│   │   ├── config.js   # настройки подключения (файл/env)
│   │   ├── db.js       # ensureDatabase / runMigrations / seed / status
│   │   └── server.js   # REST API + раздача фронтенда
│   ├── db/             # SQL-миграции, seed, DATA_MODEL.md
│   └── config/         # db.settings.json (создаётся через UI, в .gitignore)
├── frontend/           # GUI: index.html, styles.css, app.js
└── Dockerfile          # один образ: бэкенд раздаёт фронтенд
```

## Что делает

1. **Автосоздание БД.** При старте (`AUTO_INIT≠false`) проверяет наличие БД
   `orchestrator_db` и **создаёт её, если нет**, затем накатывает миграции
   (идемпотентно, через таблицу `_schema_migrations`).
2. **Графический экран настроек.** На `/` — форма с полями хост/путь, порт,
   база, логин, пароль и кнопками «Проверить подключение», «Сохранить»,
   «Создать БД и миграции», «Загрузить примеры». Внизу — состояние БД.

## Запуск (на хосте)

```bash
cd orchestrator-service/backend
npm install
PORT=4186 npm start        # UI: http://localhost:4186/
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

## Переменные окружения

`PORT` (4186), `HOST` (0.0.0.0), `AUTO_INIT` (true),
`PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE/PGADMIN_DB` — дефолты, если нет
сохранённого `db.settings.json`.

Схема БД — [backend/db/DATA_MODEL.md](backend/db/DATA_MODEL.md).
