# codex-runner

Хостовый демон, который исполняет **рассуждающие роли** конвейера (Приёмщик задач,
Архитектор, Декомпозитор и др.) через локальный **Codex CLI** (`codex exec`) на
подписке ChatGPT — вместо DeepSeek-коннектора. Аналог `programmer-runner`, но для
reasoning-ролей, а не для стадии CODING.

`CODEX-REASONING-001`.

## Зачем

Reasoning-роли по умолчанию крутятся на DeepSeek через агентный tool-loop в
оркестраторе (`runReasoningRole` → коннектор + tools-service). DeepSeek — узкое
место (отсюда адаптивный лимитер). Этот раннер позволяет делегировать выбранные
роли локальному Codex: своя авторизация (подписка ChatGPT), свой агентный tool-loop
(Codex сам читает файлы проекта — tools-service не нужен), и строгая JSON-схема
вердикта на уровне CLI (`--output-schema`), что исключает `verdict_unparsed`.

Оркестратор живёт в Linux-контейнере и не может запустить хостовый `codex` или
увидеть `~/.codex/auth.json` — поэтому демон работает на хосте, как `host-runner`/
`programmer-runner`.

## Как работает

Цикл (зеркало `programmer-runner`):

1. `GET /api/runner/next-reasoning-task[?role=CODE]` — оркестратор захватывает
   делегированную Codex задачу и возвращает **готовый промпт** (системный промпт
   роли + контекст задачи), JSON-схему вердикта и `projectPath`.
2. `codex exec --json --ephemeral --skip-git-repo-check -s read-only --output-schema <schema> -o <last>`
   (рабочий корень = `projectPath` через cwd процесса), промпт в stdin.
3. `POST /api/runner/reasoning-completed` — сдаёт вердикт. Разбор вердикта и переход
   делает оркестратор (`applyReasoningVerdict`) — тем же путём, что и DeepSeek.
4. Ошибка/таймаут → `POST /api/runner/release-reasoning-task` (захват возвращается в пул).

Какие роли идут через Codex, задаётся в оркестраторе настройкой
`codexReasoningRoles` (`app_settings.codex_reasoning_roles`, пересекается с
рассуждающими ролями). Эти роли исключаются из внутреннего DeepSeek-цикла —
конкуренции движков за одну задачу нет.

## Запуск

Сначала один раз авторизуйте Codex на машине:

```
codex login
```

Затем (демон поднимается вместе с остальными через `scripts/start-runners.ps1`):

```
npm start
```

## Переменные окружения

| Переменная | Назначение | Дефолт |
|---|---|---|
| `ORCHESTRATOR_URL` | База API оркестратора | `http://localhost:4186` |
| `ORCHESTRATOR_API_TOKEN` | Bearer-токен, если `/api` закрыт | — |
| `CODEX_CONCURRENCY` | Параллельных задач | `2` |
| `CODEX_ROLE` | Опрашивать только одну роль (иначе любую делегированную) | — |
| `CODEX_TASK_TIMEOUT_MS` | Жёсткий таймаут задачи; КОНТРАКТ: < орфан-таймаута оркестратора `RUNNER_ROLE_TIMEOUT_MS` (10 мин). `start-runners.ps1` ставит `540000` (9 мин). Принимает ms или суффикс `s`/`m`/`h` | `600000` (10 мин) |
| `CODEX_INTERVAL_MS` | Пауза между опросами при простое | `5000` |
| `CODEX_SANDBOX` | Песочница codex (`read-only`/`workspace-write`/`danger-full-access`) | `read-only` |
| `CODEX_MODEL` | Модель (иначе берётся из `~/.codex/config.toml`) | — |
| `CODEX_BIN` | Имя/путь бинарника Codex | `codex` |

## Тесты

```
npm test
```

`ReasoningRunner` и форма вызова `codex exec` покрыты юнит-тестами с подделками
(без сети и без живого Codex).
