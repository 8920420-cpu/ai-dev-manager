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
