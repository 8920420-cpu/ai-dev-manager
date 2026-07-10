# scripts — автозапуск хост-демонов

`host-runner` и `programmer-runner` — это **хост-процессы**, а не контейнеры:

- **host-runner** — гоняет `docker`/`git` на хосте, держит HTTP-мост на
  `localhost:4187` (нативный диалог выбора папки, кнопка `claude setup-token`);
- **programmer-runner** — запускает headless Claude Code (Agent SDK) на
  репозиториях хоста, использует залогиненную подписку Claude текущего
  пользователя.

Поэтому в `docker-compose.yml` их класть нельзя (в Linux-контейнере нет ни
docker-desktop хоста, ни диалогов, ни пользовательских OAuth-кредов Claude).
Автозапуск — нативный для Windows, в интерактивной сессии пользователя.

## Предусловия

- Поднят стек оркестратора (`docker compose up -d`) — демоны опрашивают
  `http://localhost:4186`.
- `node >= 18` в `PATH`.
- В `programmer-runner` установлены зависимости: `cd programmer-runner; npm install`.
- Claude залогинен на этой машине (как в VS Code) **или** задан
  `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` — иначе programmer-runner не
  сможет исполнять стадию CODING.

## Использование

```powershell
# Поднять обоих демонов сейчас (фоном, логи в logs\*.log). Идемпотентно.
.\scripts\start-runners.ps1

# Перезапустить (остановить старые, поднять заново).
.\scripts\start-runners.ps1 -Restart

# Остановить.
.\scripts\stop-runners.ps1

# Зарегистрировать автозапуск при входе пользователя (Планировщик задач).
.\scripts\register-autostart.ps1

# Снять с автозапуска.
.\scripts\unregister-autostart.ps1
```

## Переменные окружения

- `ORCHESTRATOR_URL` — по умолчанию `http://localhost:4186`.
- `ORCHESTRATOR_API_TOKEN` — Bearer, если `/api` закрыт токеном; `start-runners.ps1`
  подхватывает его из корневого `.env`.
- Прочие (`HOST_RUNNER_INTERVAL_MS`, `PROGRAMMER_*`, токены Claude) — см.
  `host-runner/bin/host-runner.js` и `programmer-runner/README.md`.

## Логи

`logs/host-runner.log`, `logs/programmer-runner.log` (+ `*.err`). Просмотр:

```powershell
Get-Content logs\programmer-runner.log -Tail 30 -Wait
```

## Авто-обновление codebase-memory вложенных корней (CODEBASE-MEMORY-AUTOREFRESH-001)

`refresh-codebase-memory.ps1` гоняет `codebase-memory update` по вложенным
memory-корням (`orchestrator-service/backend`, `programmer-runner`). Глобальные хуки
Claude Code обновляют только корень репозитория (cwd сессии), поэтому вложенные корни
раньше протухали.

```powershell
# Вложенные корни дерева ai-dev-manager (авто-поиск по tracked CLAUDE.md, кроме корня репо).
.\scripts\refresh-codebase-memory.ps1

# ВСЕ проекты оркестратора (root_path не-archived проектов из БД: ПС, LandingHub, Smeta …).
.\scripts\refresh-codebase-memory.ps1 -AllProjects

# Точечно / включить корень репо.
.\scripts\refresh-codebase-memory.ps1 -Only orchestrator-service/backend
.\scripts\refresh-codebase-memory.ps1 -IncludeRoot

# Только stale-корни (+ зеркало в PostgreSQL после обновления) — режим вотчдога.
.\scripts\refresh-codebase-memory.ps1 -IfStale -AllProjects -SyncPg

# Зарегистрировать периодическую подстраховку (Scheduled Task, каждые 30 мин).
.\scripts\register-memory-refresh-watchdog.ps1
```

Вызывается автоматически: (1) из git-хуков `post-commit`/`post-merge`
(`scripts/git-hooks`), когда коммит/влитие тронули ИСХОДНИКИ корня дерева ai-dev-manager;
(2) из Scheduled Task `ai-dev-manager codebase-memory refresh` (каждые 30 мин,
`-IfStale -AllProjects -SyncPg` — держит свежей память ВСЕХ проектов оркестратора и
зеркалит в PG; без правок кода ничего не пишет). Список проектов берётся из БД через
`scripts/list-project-roots.mjs`. Лог — `logs/codebase-memory-refresh.log`.

`update` инкрементальный (структурные изменения + changelog); полное наполнение
пустой памяти — `codebase-memory analyze <корень>` (сделано 10.07 для backend,
programmer-runner, ПС, LandingHub, Smeta). На Windows тул патчен в
`%APPDATA%\npm\node_modules\codebase-memory` (нормализация `\`→`/` в `getFileTree`) —
правка вне репо, теряется при апдейте тула (см. `CLAUDE.md` → CODEBASE-MEMORY-AUTOREFRESH-001).
