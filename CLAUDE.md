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

### Авто-обновление вложенных memory-корней (CODEBASE-MEMORY-AUTOREFRESH-001)

`codebase-memory setup` ставит глобальные хуки Claude Code, но их auto-update гоняет
`codebase-memory update .` только в **корне репозитория** (cwd сессии). Вложенные
memory-корни со своим `CLAUDE.md` + `.claude/rules` (`orchestrator-service/backend`,
`programmer-runner`) так не обновлялись и протухали.

Их держит свежими `scripts/refresh-codebase-memory.ps1`, вызываемый:
- из git-хуков `post-commit`/`post-merge` — точечно, когда коммит/влитие тронули
  ИСХОДНИКИ корня (правки самих memory-файлов игнорим; hooksPath=`scripts/git-hooks`);
- периодически из Scheduled Task `ai-dev-manager codebase-memory refresh` (каждые
  30 мин; регистрация `scripts/register-memory-refresh-watchdog.ps1`) с ключами
  `-IfStale -AllProjects -SyncPg`: `-AllProjects` перебирает `root_path` ВСЕХ
  не-archived проектов оркестратора из БД (ПС, LandingHub, Smeta и др., не только
  дерево ai-dev-manager); `-IfStale` обновляет корень, только если его исходники новее
  памяти (иначе тихо пропускает — changelog не пухнет вхолостую); `-SyncPg` при любом
  обновлении зеркалит память в PostgreSQL. Паттерн — как у RUNNER-FRESHNESS-001.

Вручную: `.\scripts\refresh-codebase-memory.ps1` (вложенные корни дерева) /
`-AllProjects` (все проекты оркестратора) / `-Only <корень>` / `-IncludeRoot` /
`-SyncPg`. Лог — `logs/codebase-memory-refresh.log`. `update` инкрементальный
(структурные изменения + changelog); полное наполнение пустой памяти —
`codebase-memory analyze <корень>` (сделано 10.07 для backend, programmer-runner,
ПС, LandingHub, Smeta — модули/модели/стек теперь реальные).

Две гочи `codebase-memory` v1.1.0 на Windows (скрипт их обходит):
- CLI на top-level читает `process.env.HOME` (setup.js) — в PowerShell/cmd HOME не
  задан, импорт падает ещё до команды; скрипт подставляет `$env:USERPROFILE`.
- **Патч глобального тула:** его `glob` отдаёт пути с `\`, а код фильтрует модули
  через `startsWith(folder+'/')` → у ВСЕХ модулей «0 файлов». Правка в
  `%APPDATA%\npm\node_modules\codebase-memory\src\utils\scanner.js` (`getFileTree`
  нормализует separator в `/`). Правка ВНЕ репозитория — теряется при `npm i -g` /
  апдейте тула; тогда analyze/update снова дадут пустые модули — накатить заново.
  (Побочно фикс улучшил и детект маршрутов/моделей корня — `update .` теперь видит
  `src/api/*` и миграции, которые раньше пропускал.)

**Зеркало во PostgreSQL (MCP-Codebase-Memory).** Таблица `codebase_memory_documents`
ключуется `(project_id, doc_key)` с фиксированными 10 ключами (и MCP-`get` принимает
строгий enum этих ключей), поэтому память вложенных корней держим как ОТДЕЛЬНЫЕ
inert-проекты (`scanner_enabled=false`, без задач/папок — Scanner их не трогает):
- `AI_DEV_MANAGER_BACKEND` → `orchestrator-service/backend`
- `AI_DEV_MANAGER_PROGRAMMER_RUNNER` → `programmer-runner`
- root ai-dev-manager остаётся `PROJECT`.

Заливка/обновление зеркала — `npm run memory:sync:pg:all` (перебирает все не-archived
проекты по их `root_path`; новые корни подхватываются автоматически). Чтение:
`orchestrator_get_codebase_memory(projectId='AI_DEV_MANAGER_BACKEND', key='modules')`.
PG-зеркало держит свежим тот же вотчдог (`-SyncPg` после обновления любого корня),
так что ручной `memory:sync:pg:all` нужен только для разовой заливки/проверки.

Немедленную свежесть (без 30-мин лага вотчдога) даёт глобальный Stop-хук Claude Code
`~/.codebase-memory/hooks/auto-update.ps1`: после локального `codebase-memory update .`
он вызывает `scripts/sync-codebase-memory-to-postgres.js --all-projects`, поэтому правки
долетают в MCP сразу по завершении сессии. `--all-projects` трогает только уже
зарегистрированные проекты (upsert по checksum, новых НЕ создаёт) — хук безопасен из
любого cwd, а ошибки/недоступность БД гасятся (Stop не падает).

Прочие проекты оркестратора (`PROJECT`=ai-dev-manager, `PROJECT_2`=ПС, `LANDINGHUB`,
`SMETA`) — обычные проекты со своими `root_path`; их память тоже наполнена (10.07) и
входит в `-AllProjects`/`memory:sync:pg:all`. Память НЕ генерится автоматически —
только `codebase-memory analyze <root>` создаёт её; вотчдог лишь поддерживает свежей
существующую (проект без `.claude/rules` в `-AllProjects`/sync тихо пропускается).

Кроме них в оркестраторе заведены память-only inert-проекты прочих git-сервисов из
`E:\git` (онбординг 17.07: `codebase-memory analyze <root>` + регистрация через
`sync-codebase-memory-to-postgres.js --root=<путь>`): `CHATBOT`, `CUSTOMERCORE`,
`PRODUCTCORE`, `BOTUSLUGI`, `FINDATE`, `HAPPYPARTYVRN`, `CONTRACTSPSSMETALIB`, `ARCHIVUM`,
`CLEAR36`, `ETL_SPLITTER`, `FASTTABLE`, `MATERIAL_BALANCES`, `PHONESERV`, `WINDTEST`,
`MONITOR` и `INFRA` (`deploy`). Все `scanner_enabled=false`; их память держат свежей тот
же `-AllProjects`/Stop-хук. Итого ~22 не-archived проекта, Scanner не включён ни у одного.
Песочницы (`lern`, `Test`) и third-party (`protoc-gen-validate`) намеренно НЕ заводили.

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
