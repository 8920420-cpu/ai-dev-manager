# CONFIG_AUDIT — аудит конфигурации, дефолтов, env и runtime-override

> CONFIG-AUDIT-001 · дата: 2026-06-29 · охват: orchestrator-service, programmer-runner
> (+ claude-reasoning-runner), codex-runner, scanner-service, tools-service, mcp-service,
> tester-service, host-runner, docker-compose, start-runners.ps1, .env.

Аудит всех конфигурационных значений (timeout/retry/interval/limit/concurrency/
model/url/paths/flags). Для каждого параметра прослежена цепочка:
**дефолт в коде → чтение env → парсинг → override → использование → эффективное
значение в runtime → есть ли стартовый лог**.

---

## 0. Резюме (главное)

Корневая проблема — **расхождение дефолтов для ОДНОГО параметра между источниками**
и **небезопасный паттерн парсинга**, из-за чего «значение в коде одно, а фактически
используется другое».

1. **Орфан-таймаут роли (`RUNNER_ROLE_TIMEOUT_MS`) имел ТРИ разных дефолта:**
   `db.js` = 15 мин, `docker-compose.yml` = 3 мин, `.env` = 10 мин. Эффективное
   значение зависело от способа запуска оркестратора. ✅ **Исправлено** — единый
   дефолт **10 мин** во всех источниках.
2. **Небезопасный парсинг `Number(process.env.X || 600000)`:** при мусоре
   (`X="abc"`) даёт `NaN`, а `setTimeout(fn, NaN)` срабатывает **немедленно** →
   таймаут мгновенно рубит каждую задачу. ✅ **Исправлено** — единый помощник
   `envConfig.js` с безопасным фолбэком на дефолт + предупреждением.
3. **Не видно источника значения в логе.** Симптом из тикета — «раннер стартует с
   `taskTimeout=150000`, хотя дефолт 10 мин». Причина: значение унаследовано из
   окружения (`start-runners.ps1` ставит дефолт только `if (-not $env:X)`), а лог не
   показывал источник. ✅ **Исправлено** — стартовый лог `effectiveConfig=` с полями
   `{ value, source: env|default, envName, defaultValue }`.
4. **Контракт «hard-timeout раннера < орфан-таймаута оркестратора»** держался лишь
   неявно. ✅ Зафиксирован в комментариях и документации; добавлена валидация
   диапазонов.

---

## 1. Таблица параметров — таймауты/орфаны (ядро инцидента)

| Параметр | Дефолт (код) | Override (env/compose/ps1) | Эффективно | Где используется | Проблема | Статус |
|---|---|---|---|---|---|---|
| `RUNNER_ROLE_TIMEOUT_MS` (орфан рассуждающих) | **было 15 мин** (`db.js`) | compose `было 180000` / `.env=600000` | зависел от запуска | `db.js` реапер захватов | **3 разных дефолта** | ✅ единый **600000** (db.js + compose + .env) |
| `RUNNER_CLAUDE_TIMEOUT_MS` (орфан программиста) | `= ROLE_TIMEOUT_MS` | compose/.env `1500000` (25 мин) | 25 мин | `db.js` `CLAUDE_ASSIGN_TIMEOUT_MS` | парс `Number(env||def)` | ✅ парс `Number(env)||def` + лог |
| `CLAUDE_REASONING_TASK_TIMEOUT_MS` | 10 мин (`bin`) | `start-runners=540000` (9 мин) | 9 мин | `ReasoningRunner` abort | NaN-риск, нет лога источника | ✅ `envConfig` + лог + диапазон `[30с..60м]` |
| `CODEX_TASK_TIMEOUT_MS` | 10 мин (`bin`) | `start-runners=540000` | 9 мин | `ReasoningRunner` abort | то же | ✅ `envConfig` + лог |
| `PROGRAMMER_TASK_TIMEOUT_MS` | 20 мин (`bin`) | — | 20 мин | `ProgrammerRunner` abort | то же | ✅ `envConfig` + лог |
| `ROLE_LLM_CALL_TIMEOUT_MS` | 3 мин (`roleEngine.js`) | env | 3 мин | DeepSeek tool-loop | NaN-риск | ✅ `envConfig` (диапазон `[1с..30м]`) |
| `TOOLS_SERVICE_TIMEOUT_MS` | 30000 (`toolsClient`) | env | 30с | вызовы tools-service | — | ✅ ок |
| `MCP_REQUEST_TIMEOUT_MS` | 30000 (`mcp config`) | env | 30с | прокси mcp→tools | `Math.max(1000,…)` есть | ✅ ок (эталон) |
| класс `ReasoningRunner.taskTimeoutMs` | 10 мин | конструктор | из bin | дубль в 2 пакетах | дубль дефолта | ⚠️ дубль (намеренный, как ReasoningRunner.js) |

**Контракт (зафиксирован):** `RUNNER_ROLE_TIMEOUT_MS` (10 мин) > hard-timeout
рассуждающих раннеров (9 мин) > полезная работа роли. Для программиста:
`RUNNER_CLAUDE_TIMEOUT_MS` (25 мин) > `PROGRAMMER_TASK_TIMEOUT_MS` (20 мин).

## 2. Таблица параметров — интервалы/параллелизм/лимиты

| Параметр | Дефолт | Override | Используется | Замечание | Статус |
|---|---|---|---|---|---|
| `RUNNER_INTERVAL_MS` | 3000 | compose/env | `taskRunner` фидер | — | ✅ |
| `*_INTERVAL_MS` (codex/claude/programmer/host) | 5000 / 3000 | env | опрос оркестратора | — | ✅ диапазон `[200..300000]` |
| `CLAUDE_REASONING_CONCURRENCY` | 2 | `start-runners=1` | воркеры | было `Math.max(1,…)` | ✅ `resolveInt [1..8]` |
| `CODEX_CONCURRENCY` | 2 | env | воркеры | — | ✅ `resolveInt [1..8]` |
| `PROGRAMMER_CONCURRENCY` | **3** (=MAX) | env + настройки БД | старт-воркеры | README говорил `1` | ✅ README исправлен |
| `PROGRAMMER_MAX_TURNS` | **100** | `.env=100` | `claudeAgent` | README говорил `60` | ✅ README исправлен |
| `CLAUDE_REASONING_MAX_TURNS` | 12 | env | разведка | — | ✅ |
| `ROLE_TOOL_MAX_ITERS` | 8 | env | roleEngine | — | ✅ |
| `RUNNER_MAX_REWORK` | 3 | env | roleEngine | — | ✅ |
| `CONNECTOR_LIMIT_*` (start/min/max/probe) | 6/2/32/15 | compose/env | AIMD-лимитер | — | ✅ |
| `SCANNER_DEBOUNCE_MS` / `SCANNER_FALLBACK_MS` | 150 / 5000 | compose/env | watcher | `??` для fallback (0 валиден) | ✅ |
| `SCANNER_*_INTERVAL_MS` | 5000 | env | опросы | — | ✅ |
| `PROJECT_MAP_TTL_MS` / `_MAX_CHARS` | 1ч / 12000 | env | projectMap | `Math.max` есть | ✅ |
| `RUNNER_CLOCK_*` | 60000 / 10000 | env | clockGuard | — | ✅ |

## 3. Модели, URL, пути, флаги

| Параметр | Дефолт | Замечание |
|---|---|---|
| `PROGRAMMER_MODEL` | `claude-opus-4-8` | ок |
| `CLAUDE_REASONING_MODEL` | `claude-sonnet-4-6` | ок |
| `CODEX_MODEL` | — (из `~/.codex/config.toml`) | ок |
| `CONNECTOR_LLM_MAX_TOKENS` | 2048 | ок |
| `ORCHESTRATOR_URL` | `http://localhost:4186` | повторяется в 5 раннерах (norm `replace(/\/+$/,'')`) — единый паттерн, ок |
| `TOOLS_SERVICE_URL` | `http://tools-service:4188` (orch) / `localhost:4188` (mcp) | **разные дефолты по контексту** (Docker-сеть vs локально) — намеренно |
| `PORT` (orchestrator) | 4186 → слушает 80 в Docker | ок |
| `TOOLS_SERVICE_PORT` / `MCP_SERVICE_PORT` / `TESTER_PORT` | 4188 / 4190 / 4187 | ок |
| `PROJECTS_HOST_ROOT` / `TOOLS_PROJECT_PATH_MAP` | `K:\Роботы\Golang\git` | ок (PROJECT-PATH-MAP-001) |
| `MCP_ENABLE_WRITE/DELETE/MUTATIONS` | 0 | feature-флаги через `truthy()` — эталон |
| `RUNNER_ENABLED` / `AUTO_INIT` / `STARTUP_RECONCILE` | `!== 'false'` | булевы флаги, ок |

---

## 4. Найденные проблемы (детально) и статус

| # | Проблема | Серьёзность | Статус |
|---|---|---|---|
| P1 | `RUNNER_ROLE_TIMEOUT_MS`: 3 разных дефолта (15/3/10 мин) | 🔴 высокая | ✅ единый 10 мин |
| P2 | `Number(env \|\| default)` → NaN-таймаут при мусоре (мгновенный abort) | 🔴 высокая | ✅ `envConfig`/`Number(env)\|\|def` |
| P3 | Нет атрибуции источника в логе (env vs default) — невозможно объяснить 150000 | 🟠 средняя | ✅ `effectiveConfig=` лог |
| P4 | `start-runners.ps1` `if (-not $env:X)` → унаследованный/устаревший env молча побеждает | 🟠 средняя | ✅ печать источника `env(inherited)/default` |
| P5 | Нет валидации диапазонов env | 🟠 средняя | ✅ `min/max` в `resolveDuration/Int` |
| P6 | Доки vs код: README `PROGRAMMER_MAX_TURNS=60` (код 100), `CONCURRENCY=1` (код 3), `PROGRAMMER_WORKTREE` удалён, орфан «≈30 мин» | 🟡 низкая | ✅ README/комментарии обновлены |
| P7 | Magic numbers (`15*60*1000`, `180000`) без имени | 🟡 низкая | ✅ `DEFAULT_ROLE_TIMEOUT_MS`; раннеры через helper |
| P8 | Единицы: всё в ms, но без поддержки `s/m/h` в env | 🟡 низкая | ✅ `parseDurationMs` принимает суффиксы |
| P9 | Дубль класса `ReasoningRunner` (codex + programmer пакеты) с одинаковым дефолтом | 🟡 низкая | ⚠️ оставлено (намеренный дубль пакетов) |
| P10 | Нет `.env.example` | 🟡 низкая | ✅ создан |

---

## 5. Что централизовано

- **Единый источник правды дефолта орфан-таймаута** — `db.js:DEFAULT_ROLE_TIMEOUT_MS`
  (10 мин); `docker-compose` и `.env` приведены к тому же значению.
- **Единый разбор числовых env** — `envConfig.js` (`resolveDuration`, `resolveInt`,
  `logEffectiveConfig`) в `programmer-runner/src` и `codex-runner/src` (копия, как
  существующий дубль `ReasoningRunner.js`). Применён во всех трёх раннер-bin.
- **Стартовый лог `effectiveConfig`** — в раннерах и оркестраторе (`db.js`).

## 6. Оставшиеся риски

- ✅ **Закрыто (CONFIG-AUDIT-002):** `roleEngine.js` (`ROLE_TOOL_*`,
  `ROLE_LLM_CALL_TIMEOUT_MS`, `RUNNER_MAX_REWORK`), `db.js`, scanner
  (`SCANNER_DEBOUNCE/FALLBACK/*_INTERVAL/HEALTH_PORT`) и tester (`TESTER_PORT`)
  переведены на `envConfig`. Прежний `Math.max(1000, Number(env||N))` при мусоре
  давал `NaN` — теперь безопасный дефолт + предупреждение.
- Дубль `envConfig.js` теперь в 5 пакетах (`programmer-runner`, `codex-runner`,
  `orchestrator-service/backend`, `scanner-service`, `tester-service`) — как и
  `ReasoningRunner.js`. Правки синхронизировать вручную (нет общего npm-пакета).
  Нижний порог `ROLE_TOOL_*` сохранён через `Math.max(1000, …)` поверх `resolveInt`.
- `start-runners.ps1` намеренно сохраняет опт-ин `if (-not $env:X)` (не ломаем
  возможность переопределить таймаут снаружи); теперь источник виден в выводе.

## 7. Изменённые файлы

**CONFIG-AUDIT-001 (таймаут-контракт):**
- `programmer-runner/src/envConfig.js` (новый) + `test/envConfig.test.js` (новый)
- `codex-runner/src/envConfig.js` (новый) + `test/envConfig.test.js` (новый)
- `programmer-runner/bin/programmer-runner.js`, `bin/claude-reasoning-runner.js`
- `codex-runner/bin/codex-runner.js`
- `orchestrator-service/backend/src/db.js` (орфан-дефолт + парс + лог)
- `docker-compose.yml` (`RUNNER_ROLE_TIMEOUT_MS` 180000→600000)
- `scripts/start-runners.ps1` (печать источника таймаутов)
- `programmer-runner/README.md`, `codex-runner/README.md` (актуализация)
- `.env.example` (новый), `CONFIG_AUDIT.md` (этот файл)

**CONFIG-AUDIT-002 (домиграция «старых» мест):**
- `orchestrator-service/backend/src/envConfig.js` (новый) + `test/envConfig.test.js` (новый)
- `scanner-service/src/envConfig.js` (новый) + `test/envConfig.test.js` (новый)
- `tester-service/src/envConfig.js` (новый) + `test/envConfig.test.js` (новый)
- `orchestrator-service/backend/src/roleEngine.js` (`ROLE_TOOL_*`, `ROLE_LLM_CALL_TIMEOUT_MS`, `RUNNER_MAX_REWORK`)
- `orchestrator-service/backend/src/db.js` (переведён на `resolveDuration`/`logEffectiveConfig`)
- `scanner-service/bin/scanner-service.js` (debounce/fallback/intervals/health-port)
- `tester-service/bin/tester-service.js` (`TESTER_PORT`, приоритет CLI > env > дефолт)
