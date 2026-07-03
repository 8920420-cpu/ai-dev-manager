# pipeline-runner

Универсальный, не зависящий от языка проекта запускатель этапов CI/CD,
управляемый исключительно файлом `.pipeline.json`.

Ядро runner (`ConfigLoader`/`PipelineRunner`/`StageRunner`) **не содержит**
никакой проектной логики: не ищет Go-модули или `package.json`, не предполагает
Docker, структуру каталогов или конкретный язык — всё поведение задаётся этапами
в конфиге.

Проектные дефолты вынесены в ОДИН модуль `ConventionConfigBuilder` и включаются
только в сервисном режиме, когда у сервиса **нет** локального `.pipeline.json`
(см. «Конвенционный режим» ниже). Ядро при этом не меняется.

## Запуск

```bash
node bin/pipeline-runner.js --config .pipeline.json
node bin/pipeline-runner.js --config services/catalog/.pipeline.json
```

После `npm link` / установки — `pipeline-runner --config .pipeline.json`.

- **stdout** — финальный JSON-результат (для оркестратора).
- **stderr** — ход выполнения (дублируется в `pipeline.log`).
- **код возврата**: `0` — успех, `1` — упал этап, `2` — ошибка конфига/запуска.

## Конфигурация `.pipeline.json`

```json
{
  "name": "Catalog_Service",
  "workingDirectory": ".",
  "timeoutMinutes": 30,
  "stages": {
    "test":   { "enabled": true,  "commands": ["go test ./..."] },
    "lint":   { "enabled": true,  "commands": ["go vet ./..."] },
    "build":  { "enabled": true,  "commands": ["docker compose build catalog-service"] },
    "deploy": { "enabled": false, "commands": ["docker compose up -d catalog-service"] },
    "smoke":  { "enabled": true,  "commands": ["curl -f http://localhost:8080/health"] }
  }
}
```

- `name` — имя проекта (для отчёта). По умолчанию `pipeline`.
- `workingDirectory` — рабочий каталог команд, относительно расположения конфига.
- `timeoutMinutes` — общий бюджет времени; транслируется в таймаут команд.
- `stages` — упорядоченный набор этапов; **порядок ключей = порядок выполнения**.
  Имена этапов произвольны — runner не знает их заранее. Каждый этап —
  объект `{ "commands": [...], "enabled": true|false }`: оба поля обязательны.
  Старый формат (массив команд) и объект без `enabled` отклоняются с ошибкой
  конфигурации (LEGACY-PIPELINE-CONFIG-001) — неявного включения нет.

Команды этапа выполняются последовательно. Первая упавшая команда
останавливает этап и весь pipeline; следующие этапы не запускаются.

## Результаты

Для каждого запуска создаётся изолированный каталог:

```
.tmp/pipeline-results/2026-06-21T14-22-15/
  ├── summary.json   # машиночитаемый итог
  └── pipeline.log   # полный лог (stdout/stderr всех команд)
```

Параллельные запуски безопасны: каждый получает свой `runId`-каталог,
глобальных файлов и блокировок нет.

### Возвращаемый объект

```json
{ "success": true,  "runId": "2026-06-21T14-22-15", "reportPath": ".tmp/pipeline-results/..." }
{ "success": false, "failedStage": "build", "runId": "...", "reportPath": "..." }
```

## Сервисный режим PIPELINE_SERVICE (без AI)

Для роли оркестратора `PIPELINE_SERVICE` runner запускается как обычный
**не-AI** worker: сервис выбирается строго по устойчивому контракту claim
(`task.pipeline`), а **не** по свободному тексту, prompt или текущей директории.
Ни на одном шаге нет обращения к LLM/AI-коннектору/модели.

```bash
# claim — объект задачи из GET /api/runner/next-host-task (поле pipeline обязательно)
pipeline-runner --task claim.json --projects-root /abs/projects/root
cat claim.json | pipeline-runner --task - --projects-root /abs/projects/root
```

- `--projects-root` — **абсолютный** корень всех проектов на хосте; от него
  резолвятся относительные `projectRoot`/`repositoryPath` из контракта.
- Path isolation: рабочая директория и `.pipeline.json` сервиса обязаны лежать
  внутри `projectRoot`; выход за корень, путь соседнего сервиса или
  неизвестный/удалённый сервис → диагностируемая ошибка **до запуска команд**.
- Результат — DTO для `POST /api/runner/host-task-completed`:
  `{ taskId, roleCode:"PIPELINE_SERVICE", success, output:{ summary, failedStage,
  startedAt, logPath } }`. `summary` содержит `projectId`, `serviceId`, имя
  сервиса и `actions[]` (status, exitCode, durationMs, безопасный фрагмент лога).

Как библиотека:

```js
import { runServicePipeline } from './src/index.js';
const result = await runServicePipeline(task, { projectsRoot: '/abs/projects/root' });
```

### Конвенционный режим (без локального `.pipeline.json`)

Если у сервиса **нет** `.pipeline.json`, движок (`ConventionConfigBuilder`) сам
собирает стадии по конвенции монорепо, зная только путь сервиса и корень проекта:

- **test** — по стеку сервиса: `go.mod` → `go test ./...`; `package.json` со
  скриптом `test` → `npm test`; иначе стадия **SKIPPED** (`no_tests_detected`).
- **build** — ближайший вверх `docker-compose.yml` (= подсистема `CRM/`,
  `PS-Torg/`, `WebStore/`, `Print/`…) → `docker compose -f <compose> build`.
- **deploy** — тот же compose → `docker compose -f <compose> up -d`.
- **smoke** — если в compose объявлен `healthcheck` → ожидание healthy
  (`docker compose -f <compose> up -d --wait`); иначе **SKIPPED**
  (`no_healthcheck_in_compose`).

Compose ищется **строго внутри** `projectRoot` (path isolation сохраняется). Если
compose до корня проекта не найден — построитель бросает `ConventionError`
(`pipeline_compose_not_found`), что даёт диагностируемый провал стадии `deploy`.

Локальный `.pipeline.json` — **необязательное переопределение** конвенции:

- по умолчанию — **целиком** (файл используется как есть, конвенция игнорируется);
- при `"extendsConvention": true` — **постадийно**: за основу берутся
  конвенционные стадии, одноимённые стадии из файла переопределяют их целиком,
  новые — добавляются в конец.

Дефолты живут в одном месте — правка `ConventionConfigBuilder` применяется сразу
ко всем сервисам, а в репозиториях сервисов не появляется ни одного конфиг-файла.

## Архитектура

| Компонент         | Ответственность                                         |
|-------------------|---------------------------------------------------------|
| `ConfigLoader`    | чтение и валидация `.pipeline.json`                     |
| `ConventionConfigBuilder` | дефолты по конвенции монорепо (стадии по пути сервиса), когда `.pipeline.json` отсутствует |
| `PipelineRunner`  | оркестрация запуска, каталог результатов, summary.json  |
| `StageRunner`     | выполнение одного этапа, остановка на первой ошибке     |
| `CommandExecutor` | запуск одной команды, захват stdout/stderr/кода/времени |
| `Logger`          | запись `pipeline.log`                                   |
| `ResultWriter`    | запись `summary.json`                                   |
| `ServicePipelineTask` | сервисный (не-AI) запуск по claim: валидация контракта, path isolation, structured-результат для оркестратора |

Использование как библиотеки:

```js
import { runPipeline } from './src/index.js';
const result = await runPipeline({ configPath: '.pipeline.json' });
```

## Тесты

```bash
npm test   # node --test
```

Покрыто: валидация конфига, выполнение/таймаут/ошибки команд, остановка
этапа на сбое, остановка pipeline, запись summary.json/pipeline.log,
уникальность каталогов при параллельных запусках, сквозные сценарии.
```

Требования: Node.js >= 18.
