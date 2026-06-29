# programmer-runner

Автоматический исполнитель роли **PROGRAMMER** (стадия `CODING`).

## Зачем

В конвейере reasoning-роли (Intake/Architect/Decomposer/Reviewer/…) исполняет сам
оркестратор через модель, host-роли (`PIPELINE_SERVICE`/`GIT_INTEGRATOR`) —
`host-runner`. А роль `PROGRAMMER` («файловый мост») не исполнял **никто
автоматически** — её двигала только живая Claude-сессия через MCP
`claim → код → complete`. Если такой сессии нет, задачи копятся в `CODING`, по
таймауту орфан-захвата освобождаются, а оператор периодически делает
«перезапуск зависших» → массовый `RESTART` и повторный прогон reasoning-ролей
вхолостую.

`programmer-runner` закрывает этот разрыв: демон опрашивает оркестратор,
запускает **headless Claude Code** (Claude Agent SDK) на задаче в рабочем дереве
проекта и сдаёт результат обратно в БД.

## Как работает

```
[N воркеров] claim GET /api/runner/next-claude-task
  └─ есть задача → resolveRepo(project) → git worktree от HEAD
                   → headless query() в cwd worktree (изоляция)
                   → integrate: serial apply diff worktree → main = changedFiles
                   → успех:  POST /api/scanner/task-completed (completionKey из задачи)
                   → провал/таймаут/конфликт слияния/ошибка сдачи:
                              POST /api/runner/release-claude-task (re-queue)
  └─ нет задачи / слоты заняты → пауза INTERVAL_MS
```

- **Изоляция через git worktree на задачу** (включена по умолчанию): каждый агент
  правит в собственном линкованном worktree (своя ветка от HEAD), поэтому правки
  параллельных задач не текут друг в друга. Дорогой шаг (LLM) идёт параллельно,
  дешёвый «слить в main» сериализуется под локом; конфликт перекрытия правок →
  задача возвращается в очередь. `PROGRAMMER_WORKTREE=0` — выключить (legacy:
  правки прямо в основном дереве, безопасно только при `concurrency=1`).
- **Параллелизм `PROGRAMMER_CONCURRENCY`** воркеров над одним runner; захваты
  безопасны (claim берёт строку `FOR UPDATE SKIP LOCKED`). Коммитит изменения
  позже стадия `GIT_INTEGRATOR` (работает с main как раньше).
- **Список изменённых файлов считает драйвер** через `git` (diff worktree, либо
  снимок до/после в legacy-режиме), а не берёт из самоотчёта агента.
- **`complete` зовёт драйвер** по исходу агента — агенту не нужен доступ к
  мутациям оркестратора (MCP вообще не подключается).
- `completionKey` берётся из блока `completion` задачи (содержит id события
  `AGENT_ASSIGNED`) → повторная сдача идемпотентна.

## Запуск

```bash
npm install
# Аутентификация — один из трёх вариантов (см. ниже). Проще всего: на машине уже
# выполнен вход в Claude Code по подписке (как в VS Code) — ключ не нужен.
ORCHESTRATOR_URL=http://localhost:4186 \
node bin/programmer-runner.js
```

### Аутентификация (подписка, без API-ключа)

Демон запускает headless Claude Code через Agent SDK, поэтому использует ту же
авторизацию, что и `claude` CLI. Варианты по приоритету удобства:

1. **Подписка Claude Code** — если на этой машине уже выполнен вход (`claude`
   залогинен, как в VS Code), SDK подхватывает сохранённые OAuth-креды. API-ключ
   не нужен. Демон должен работать под тем же пользователем (доступ к хранилищу
   креденшелов / `HOME`/`USERPROFILE`).
2. **Долгоживущий токен подписки** — `claude setup-token` → положить результат в
   `CLAUDE_CODE_OAUTH_TOKEN`. Рекомендуется для неинтерактивного демона (не
   зависит от интерактивной сессии).
3. **API-ключ** — `ANTHROPIC_API_KEY` (обычный pay-as-you-go).

> Если задан `ANTHROPIC_API_KEY`, он имеет приоритет над подпиской. Чтобы демон
> шёл именно по подписке — не задавай `ANTHROPIC_API_KEY`.

## Переменные окружения

| Переменная | По умолчанию | Назначение |
|---|---|---|
| _(подписка Claude Code)_ | — | если `claude` залогинен — ключ/токен не нужны |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | токен подписки от `claude setup-token` (для демона) |
| `ANTHROPIC_API_KEY` | — | API-ключ (альтернатива подписке; перебивает её) |
| `ORCHESTRATOR_URL` | `http://localhost:4186` | база HTTP оркестратора |
| `ORCHESTRATOR_API_TOKEN` | — | Bearer, если `/api` закрыт токеном |
| `PROGRAMMER_CONCURRENCY` | `3` (= MAX_CONCURRENCY) | стартовое число воркеров; на лету берётся из настроек (Настройки → Выполнение), кламп `[1..3]` |
| `PROGRAMMER_INTERVAL_MS` | `5000` | пауза между опросами (диапазон `200..300000`) |
| `PROGRAMMER_TASK_TIMEOUT_MS` | `1200000` (20 мин) | жёсткий таймаут на задачу; КОНТРАКТ: < орфан-таймаута программиста `RUNNER_CLAUDE_TIMEOUT_MS` (.env = 1500000 ≈ 25 мин). Единицы: ms или суффикс `s`/`m`/`h` |
| `PROGRAMMER_SETTINGS_POLL_MS` | `15000` | период опроса настройки параллельности |
| `PROGRAMMER_MODEL` | `claude-opus-4-8` | модель агента |
| `PROGRAMMER_MAX_TURNS` | `100` | лимит ходов агента (читается в `claudeAgent.js`) |
| `PROGRAMMER_REPO_MAP` | — | JSON-переопределение карты `project → {cwd, env}` |

> `PROGRAMMER_WORKTREE` удалён (commit 23d754f): worktree-изоляция на микросервис —
> единственный режим. См. [CONFIG_AUDIT.md](../CONFIG_AUDIT.md) о едином разборе env.

### Рассуждающий раннер (та же кодовая база, `bin/claude-reasoning-runner.js`)

| Переменная | По умолчанию | Назначение |
|---|---|---|
| `CLAUDE_REASONING_INTERVAL_MS` | `5000` | пауза между опросами |
| `CLAUDE_REASONING_TASK_TIMEOUT_MS` | `600000` (10 мин) | жёсткий таймаут; КОНТРАКТ: < орфан `RUNNER_ROLE_TIMEOUT_MS` (10 мин); `start-runners.ps1` ставит `540000` (9 мин) |
| `CLAUDE_REASONING_CONCURRENCY` | `2` | воркеры; `start-runners.ps1` ставит `1` (избежать rate-limit подписки) |
| `CLAUDE_REASONING_MODEL` | `claude-sonnet-4-6` | модель рассуждающей роли |
| `CLAUDE_REASONING_MAX_TURNS` | `12` | кап глубины разведки |
| `CLAUDE_REASONING_ROLE` | — | если задана — опрашивать только эту роль |

Карта репозиториев по умолчанию: `PROJECT_2 → …/PS` (с `GOWORK=off`),
`PROJECT → …/ai-dev-manager`.

## Тесты

```bash
npm test   # node --test; ProgrammerRunner/resolver/prompt на подделках, без сети и без Claude
```

`ProgrammerRunner` инъектирует `http` и `runAgent`, поэтому логика покрыта
юнит-тестами. `src/claudeAgent.js` — «грязный край» (реальные SDK + git), как
`host-runner/actions.js`; юнит-тестами не покрыт.

## Дальше (V2+)

- Конкурентность `N` воркеров + **git worktree на задачу** (иначе изменения задач
  протекают друг в друга — в общем дереве уже копится грязь).
- Метрики/логи per-task (claim→complete/release, стоимость, длительность).
- Выбор модели по приоритету задачи; учёт бюджета Anthropic (он отдельный от
  DeepSeek-лимитера reasoning-ролей).
- Возможно — исполнение роли `SCANNER` тем же демоном.
