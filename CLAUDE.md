# ai-dev-manager — правила для Claude

## Codebase Memory

Память проекта сгенерирована `codebase-memory` 2026-07-10. Для первичной ориентации сначала читай:

- `.claude/rules/architecture.md` — карта папок, entry points, data flow
- `.claude/rules/stack.md` — стек, версии, команды
- `.claude/rules/modules.md` — модули и их ответственность
- `.claude/rules/models.md` — схемы БД, типы, сущности
- `.claude/rules/api.md` — маршруты и endpoints
- `.claude/rules/conventions.md` — naming, patterns, testing
- `.claude/rules/gotchas.md` — quirks, workarounds, do-not-touch
- `.claude/rules/changelog.md` — что менялось и когда

Если память выглядит устаревшей, проверяй исходники и обновляй память через `codebase-memory.cmd update .`.

### ПРАВИЛО: Codebase Memory MCP — по умолчанию, без напоминаний

При любой задаче, где нужна ориентация в кодовой базе (что где лежит, архитектура,
модули, модели, API, соглашения, gotchas), **сначала по умолчанию** сверяйся с
Codebase Memory через MCP — без отдельной просьбы пользователя:

- `orchestrator_list_codebase_memory` (projectId=`PROJECT` для ai-dev-manager или
  `PROJECT_2`/… для других) — увидеть список доступных документов памяти;
- `orchestrator_get_codebase_memory` (key: `architecture|stack|modules|models|api|
  conventions|gotchas|changelog|claude`) — прочитать нужный документ.

Это тот же контент, что и `.claude/rules/*.md`, но зеркалированный в PostgreSQL и
доступный по всем проектам оркестратора (не только по текущему рабочему дереву).
MCP-инструменты бьют в защищённые эндпоинты `/api/projects/:id/codebase-memory*` и
требуют `ORCHESTRATOR_API_TOKEN` (см. `.mcp.json` → `${ORCHESTRATOR_API_TOKEN}`);
без токена вызовы вернут `401`.

## ЖЕЛЕЗНОЕ ПРАВИЛО: после правки кода раннеров — рестарт демона

Хостовые демоны (`host-runner`, `programmer-runner`, `codex-runner`,
`claude-reasoning-runner`) — долгоживущие node-процессы. Правка их кода
(включая `pipeline-runner/src`, который импортирует host-runner) **не подхватывается
сама** — процесс продолжает крутить старый код. Это дважды приводило к инцидентам
(05.07 — заглушка-самотесты; 08.07 — GI без авто-stash уронил 8 задач в BLOCKED).

После ЛЮБОЙ правки/коммита/вливания кода раннера:

```powershell
powershell -File scripts/start-runners.ps1 -Restart -Only host-runner   # или другой демон
```

Проверка на подозрение «крутится старьё»: сравни `CreationDate` процесса
(`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) с датой последней
правки исходников — процесс старше кода означает устаревший демон.

Автоматика (RUNNER-FRESHNESS-001), которая это подстраховывает, но не отменяет правило:
- `scripts/ensure-fresh-runners.ps1` — вотчдог: демон старше кода → точечный рестарт;
- Scheduled Task `ai-dev-manager runner freshness` — вотчдог каждые 10 минут
  (регистрация: `scripts/register-freshness-watchdog.ps1`);
- git-хуки `post-commit`/`post-merge` — зовут вотчдог сразу после коммита/pull,
  тронувшего каталоги раннеров (hooksPath = `scripts/git-hooks`).

## Прочее важное

- Оркестратор живёт в Docker (`orchestrator-service`, порт 4186): правки его backend
  доезжают только после `docker compose up -d --build orchestrator-service`.
- Авто-доставка в k3s (TASK-AUTODEPLOY-K3S-001): Git Integrator после вливания дельты
  читает карту `deploy/autodeploy.json` целевого репозитория и сам делает
  build → push → rollout; провал доставки = провал роли (`autodeploy_failed`).
  Повторный прогон GI по уже влитой дельте — штатный ретрай доставки
  (`already_integrated_content`), не ошибка.
- Консоль Windows калечит кириллицу в выводе node/psql: результаты запросов писать
  в файл и читать Read'ом; к БД ходить Node+`pg` из `orchestrator-service/backend`
  (host 127.0.0.1:5432, haproxy).
