# ai-dev-manager — правила для Claude

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
