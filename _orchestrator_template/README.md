# _orchestrator_template — эталон структуры проекта

Это **источник истины** для структуры любого проекта и сервиса, управляемого оркестратором.
Роль [Structure Keeper](../roles/structure-keeper.md) приводит каждый проект к этому эталону.

Текущая версия структуры — см. [version.json](version.json) (`orchestrator_structure_version`).

## Что описывает эталон

```text
_orchestrator_template/
├── version.json              # версия структуры (источник истины)
├── README.md                 # этот файл
├── .pipeline.json            # шаблон конфигурации pipeline сервиса
├── tasks/                    # эталонная структура очереди задач
│   ├── inbox/                # сырые задачи до триажа
│   ├── ready/                # готовы к работе (Programmer забирает отсюда)
│   ├── in_progress/          # в работе
│   ├── review/               # код готов, идёт ревью
│   ├── qa/                   # проверка/тесты/pipeline
│   ├── blocked/              # заблокировано (рядом причина)
│   ├── done/                 # завершено
│   ├── archive/              # история и legacy-постановки
│   └── TASK.template.md      # шаблон одного task-файла
├── docs/                     # шаблоны обязательной документации сервиса
│   ├── PROJECT_MAP.template.md
│   ├── ARCHITECTURE.template.md
│   ├── API_MAP.template.md
│   ├── DATABASE_MAP.template.md
│   └── DECISIONS.template.md
├── .orchestrator/            # шаблон служебной конфигурации сервиса
│   ├── version.json
│   ├── service.json
│   ├── locks.json
│   ├── last_scan.json
│   ├── migrations.log
│   └── structure_report.md
└── migrations/               # миграции структуры между версиями
    ├── README.md
    ├── 0.0.0_to_1.0.0.md     # bootstrap: нет структуры → 1.0.0 (применяется реально)
    ├── 1.0.0_to_1.1.0.md     # пример формата будущей миграции
    ├── 1.1.0_to_1.2.0.md     # пример формата будущей миграции
    └── 1.2.0_to_1.3.0.md     # пример формата будущей миграции
```

## Обязательные артефакты сервиса

Каждый сервис, приведённый к эталону, обязан иметь:

- структуру `tasks/` из 8 стадий;
- документы `PROJECT_MAP.md`, `ARCHITECTURE.md`, `API_MAP.md`, `DATABASE_MAP.md`, `DECISIONS.md`;
- `.pipeline.json`;
- каталог `.orchestrator/` с `version.json`, `service.json`, `locks.json`, `last_scan.json`,
  `migrations.log`, `structure_report.md`.

## Правила работы с эталоном

- Structure Keeper только **создаёт отсутствующее** из шаблонов; существующий контент не перезаписывает.
- Версия структуры сервиса (`.orchestrator/version.json`) всегда сверяется с этим эталоном.
- Несовпадение версий устраняется миграциями из `migrations/` по порядку.
- Неизвестный путь миграции — остановка без изменений и ошибка в отчёте.
- Глобальные `_orchestrator/services_registry.json` и `_orchestrator/dependencies.json` поддерживаются
  в актуальном состоянии при каждом запуске.
