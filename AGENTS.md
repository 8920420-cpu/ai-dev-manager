# ai-dev-manager — правила для Codex

## Codebase Memory

Память проекта сгенерирована `codebase-memory` 2026-07-10. Для первичной ориентации сначала используй:

- `.claude/rules/architecture.md` — карта папок, entry points, data flow
- `.claude/rules/stack.md` — стек, версии, команды
- `.claude/rules/modules.md` — модули и их ответственность
- `.claude/rules/models.md` — схемы БД, типы, сущности
- `.claude/rules/api.md` — маршруты и endpoints
- `.claude/rules/conventions.md` — naming, patterns, testing
- `.claude/rules/design-system.md` — обязательная цветовая схема приложений и правила её применения
- `.claude/rules/gotchas.md` — quirks, workarounds, do-not-touch
- `.claude/rules/changelog.md` — что менялось и когда
- `CONVENTIONS.md` — сгенерированные project conventions для инструментов без Claude Memory

Если память выглядит устаревшей, проверяй исходники и обновляй её:

```powershell
$env:HOME=$HOME; codebase-memory.cmd update .
```

PowerShell может блокировать `codebase-memory.ps1`, поэтому на Windows используй `codebase-memory.cmd`.

## ЖЕЛЕЗНОЕ ПРАВИЛО: после правки кода раннеров — рестарт демона

Хостовые демоны (`host-runner`, `programmer-runner`, `codex-runner`,
`claude-reasoning-runner`) — долгоживущие node-процессы. Правка их кода
(включая `pipeline-runner/src`, который импортирует host-runner) не подхватывается
сама — процесс продолжает крутить старый код.

После любой правки/коммита/вливания кода раннера:

```powershell
powershell -File scripts/start-runners.ps1 -Restart -Only host-runner
```

Проверка на подозрение «крутится старьё»: сравни `CreationDate` процесса
(`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) с датой последней
правки исходников.

## Прочее важное

- Оркестратор живёт в Docker (`orchestrator-service`, порт 4186): правки его backend
  доезжают только после `docker compose up -d --build orchestrator-service`.
- Авто-доставка в k3s (TASK-AUTODEPLOY-K3S-001): Git Integrator после вливания дельты
  читает карту `deploy/autodeploy.json` целевого репозитория и сам делает
  build → push → rollout; провал доставки = провал роли (`autodeploy_failed`).
- Консоль Windows калечит кириллицу в выводе node/psql: результаты запросов писать
  в файл и читать Read'ом; к БД ходить Node+`pg` из `orchestrator-service/backend`
  (host 127.0.0.1:5432, haproxy).

## Кодировка файлов

- Все текстовые файлы проекта (`.md`, `.env`, `.js`, `.ts`, `.json`, `.yml`, `.yaml`,
  `.sql`, `.conf`, `.ps1`, `.sh`) хранить в UTF-8 без BOM.
- Не сохранять новые файлы в Windows-1251/CP866 и не копировать в исходники
  mojibake из консоли (например, двойные UTF-8/Windows-1251 последовательности
  или серии символов U+FFFD).
- Перед исправлением кириллицы проверять реальные байты файла, а не только вывод
  PowerShell: Windows-консоль может искажать нормальный UTF-8 при печати.
- Если PowerShell пишет файл с кириллицей, явно задавать UTF-8: в PowerShell 7
  использовать `Set-Content -Encoding utf8`, для совместимости с Windows PowerShell
  предпочтительно писать через `[System.IO.File]::WriteAllText($path, $text,
  [System.Text.UTF8Encoding]::new($false))`.
