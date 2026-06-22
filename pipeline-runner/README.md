# pipeline-runner

Универсальный, не зависящий от языка проекта запускатель этапов CI/CD,
управляемый исключительно файлом `.pipeline.json`.

Runner **не содержит** никакой проектной логики: не ищет Go-модули или
`package.json`, не предполагает Docker, структуру каталогов или конкретный язык.
Всё поведение задаётся этапами в конфиге.

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
    "test":   ["go test ./..."],
    "lint":   ["go vet ./..."],
    "build":  ["docker compose build catalog-service"],
    "deploy": ["docker compose up -d catalog-service"],
    "smoke":  ["curl -f http://localhost:8080/health"]
  }
}
```

- `name` — имя проекта (для отчёта). По умолчанию `pipeline`.
- `workingDirectory` — рабочий каталог команд, относительно расположения конфига.
- `timeoutMinutes` — общий бюджет времени; транслируется в таймаут команд.
- `stages` — упорядоченный набор этапов; **порядок ключей = порядок выполнения**.
  Имена этапов произвольны — runner не знает их заранее.

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

## Архитектура

| Компонент         | Ответственность                                         |
|-------------------|---------------------------------------------------------|
| `ConfigLoader`    | чтение и валидация `.pipeline.json`                     |
| `PipelineRunner`  | оркестрация запуска, каталог результатов, summary.json  |
| `StageRunner`     | выполнение одного этапа, остановка на первой ошибке     |
| `CommandExecutor` | запуск одной команды, захват stdout/stderr/кода/времени |
| `Logger`          | запись `pipeline.log`                                   |
| `ResultWriter`    | запись `summary.json`                                   |

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
