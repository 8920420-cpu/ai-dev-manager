# scanner-service

Файловый мост между Claude Code в VS Code и AI Orchestrator.

## Как работает

1. Оркестратор или пользователь добавляет задачу в `tasks/claude-tasks.json`.
2. Claude выполняет задачу, заполняет `result`, `changedFiles`, `completedAt` и
   последним действием ставит `status: "выполнено"`.
3. Scanner замечает изменение и вызывает
   `POST /api/scanner/task-completed`.
4. Оркестратор проверяет UUID, проект и сервис, после чего переводит задачу к
   `TASK_REVIEWER`.
5. Успешная доставка фиксируется в `tasks/.scanner-state.json`; повторное
   сохранение документа не создаёт новый запуск.

## Формат документа

```json
{
  "version": 1,
  "tasks": [{
    "id": "UUID задачи из orchestrator_db",
    "project": "PS",
    "service": "Chat_Service",
    "title": "Исправить reconnect",
    "status": "готово к работе",
    "result": "",
    "changedFiles": [],
    "completedAt": null
  }]
}
```

Допустимые завершённые статусы: `выполнено`, `done`, `completed`.

## Запуск

В Docker сервис стартует вместе с `docker compose up -d`. Локально:

```text
cd scanner-service
npm start
```

Сервис следит за документом через `fs.watch` (события файловой системы), а не
опросом по таймеру. Несколько событий от одного сохранения схлопываются дебаунсом
(`SCANNER_DEBOUNCE_MS`, по умолчанию 150 мс).

Дополнительно работает редкий резервный опрос (`SCANNER_FALLBACK_MS`, по умолчанию
5000 мс; `0` — выключить) — страховка на случай, когда события `fs.watch` не доходят.
Это актуально в Docker: bind-mount на Windows/Mac обычно не пробрасывает inotify
с хоста в контейнер, поэтому без резервного опроса изменения файла можно не увидеть.
`scanOnce` идемпотентен, поэтому повторные проходы не создают дублей.

Переменные: `SCANNER_DOCUMENT`, `SCANNER_STATE`, `SCANNER_ENDPOINT`,
`SCANNER_DEBOUNCE_MS`, `SCANNER_FALLBACK_MS`, `ORCHESTRATOR_API_TOKEN`.

## Интейк задач из Markdown-очередей `tasks/<service>.md` (SCANNER-INTAKE-001)

Помимо слота `claude-tasks.json`, сканер **импортирует задачи из Markdown-очередей по
сервису** `tasks/<service>.md`. Очередь — это один файл со списком задач секциями
`### [маркер] PX.Y <ID> — <title>` и frontmatter с кодом сервиса:

```markdown
---
service: ORCHESTRATOR
---
# orchestrator-service
…
### [x] P0.1 PIPELINE-STAGE-CONFIG-001 — контракт включения этапов
Pre-coding brief:
- …
```

Каждые `SCANNER_INTAKE_INTERVAL_MS` сканер рекурсивно обходит папку задач (без `archive/`
и служебных `README.md`/`TASK.template.md`) и для каждой секции с маркером **`[x]`**
вызывает `POST /api/scanner/task-intake`:

- `externalId = <SERVICE>-<PX.Y>` (напр. `ORCHESTRATOR-P0.1`, где `<SERVICE>` — из
  frontmatter `service`), `title` — текст после `—`, `description` — тело секции;
- оркестратор создаёт задачу в БД (новый UUID, `external_id` для идемпотентности),
  при необходимости авто-регистрирует сервис, и ставит её на `TASK_REVIEWER` (`REVIEW`);
- после успешного импорта (в т.ч. `duplicate`) сканер **вырезает секцию из файла**
  (re-read + atomic rename) — задача дальше живёт только в БД.

Маркеры `[ ]`/`[B]`/`[~]`/`[R]`/`[!]` пропускаются. Очередь без frontmatter `service`
пропускается с предупреждением. Идемпотентность — `UNIQUE (project_id, external_id)` в БД
плюс повторное вырезание (state-файл не нужен): если процесс упал между отправкой и
записью, следующий проход получит `duplicate` и всё равно очистит файл.

Включается заданием **проекта-владельца** `SCANNER_INTAKE_PROJECT` (значение —
`code`|`name`|`root_path` проекта). Без него интейк выключен. Доп. переменные:
`SCANNER_INTAKE_DIR` (по умолчанию каталог документа), `SCANNER_INTAKE_INTERVAL_MS`.
