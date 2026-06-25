# Role pipeline

> **Промты ролей хранятся в БД** (`roles.prompt`), а не в md-файлах. Редактируются
> в модальном окне роли на экране «Роли» (поле «Рабочий промт») и сохраняются через
> `PUT /api/roles/:code`. Начальные тексты залиты миграцией
> `orchestrator-service/backend/db/migrations/0016_role_prompts.sql`.

Основной маршрут:

```text
Structure Keeper (системная роль, всегда первой)
  → Task Intake Officer (Приёмщик задач — первая роль движения)
  → Architect
  → Decomposer
  → Programmer
  → Task Reviewer
  → Pipeline Service
  → Documentation Auditor
  → Documentation Keeper (только при UPDATE_REQUIRED)
  → Git Integrator
  → Done
```

`Structure Keeper` запускается при старте/перезапуске программы и при создании нового проекта или сервиса,
до всех остальных ролей. Он не выполняет бизнес-задачи: только приводит структуру проекта к эталону
`_orchestrator_template/`.

`Task Intake Officer` (Приёмщик задач) — **первая роль движения задачи**: классифицирует входящий запрос
и готовит карточку задачи (см. `roles/task-intake-officer.md`). Задачи поступают либо из модального окна
UI, либо от роли `Scanner`.

`Scanner` **больше не входит в движение по ролям** — это отдельная роль‑приёмник: следит за «папкой
документов» проекта (`projects.docs_path`), забирает файл задачи, пишет задачу в БД, удаляет файл и
ставит задаче роль `Task Intake Officer`. Scanner — единственная роль, работающая с файловой системой;
все остальные роли читают/меняют/пишут задачи **только в БД**.

Условные возвраты:

- `Task Reviewer: NEEDS_FIX` → Programmer;
- `Pipeline Service: failed` → Failure Analyst → Programmer;
- `Documentation Auditor: NO_CHANGES` → Git Integrator;
- архитектурное противоречие на любом этапе → Architect;
- блокер, который нельзя устранить из контекста проекта → User.

Роли, которые ИИ-движок исполняет рассуждением по промту из БД, перечислены в
`LLM_ROLE_CODES` (`orchestrator-service/backend/src/roleEngine.js`):
`TASK_INTAKE_OFFICER`, `ARCHITECT`, `DECOMPOSER`, `TASK_REVIEWER`, `FAILURE_ANALYST`,
`DOCUMENTATION_AUDITOR`, `DOCUMENTATION_KEEPER`. Остальные роли исполняются вне ИИ
(`PROGRAMMER`/`SCANNER` — файловый мост, `PIPELINE_SERVICE`/`GIT_INTEGRATOR` — host-мост),
но их промты тоже хранятся в БД и доступны в модалке роли.
