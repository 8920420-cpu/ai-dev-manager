# scanner-service

Файловый мост между Claude Code в VS Code и AI Orchestrator.

## Как работает

1. Оркестратор или пользователь добавляет задачу в `runtime/claude-tasks.json`.
2. Claude выполняет задачу, заполняет `result`, `changedFiles`, `completedAt` и
   последним действием ставит `status: "выполнено"`.
3. Scanner замечает изменение и вызывает
   `POST /api/scanner/task-completed`.
4. Оркестратор проверяет UUID, проект и сервис, после чего переводит задачу к
   `TASK_REVIEWER`.
5. Успешная доставка фиксируется в `runtime/.scanner-state.json`; повторное
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
