# Legacy: сервисные очереди задач

Это исторические файлы прежней модели очереди — по одному markdown-файлу на сервис со статус-маркерами
`[ ]` / `[B]` / `[~]` / `[R]` / `[!]` / `[x]`. Они сохранены для истории при переходе на папочную модель
эталона `_orchestrator_template/` (версия структуры 1.0.0).

Все активные задачи из этих файлов разложены по стадиям новой модели в `tasks/<стадия>/` отдельными
файлами. Здесь **новые задачи не добавляются** и статусы не поддерживаются.

| Файл | Сервис | Куда разложены задачи |
|---|---|---|
| `orchestrator-service.md` | ORCHESTRATOR | `ready/` (P1.2, P1.3, P1.4, P2.2, P2.3), `review/` (P0.1, P1.1, P2.1) |
| `frontend.md` | FRONTEND | `ready/` (P1.3), `review/` (P0.1, P1.1, P1.2, P2.1, P2.2) |
| `pipeline-runner.md` | PIPELINE_RUNNER | `ready/` (P1.2, P2.1), `review/` (P1.1) |
| `scanner-service.md` | SCANNER | `review/` (P1.1), `blocked/` (P1.2, P2.1) |
| `Integration.md` | INTEGRATION | `ready/` (P2.1–P2.4, P3.1) |
| `tester-service.md` | TESTER | открытых задач не было |
