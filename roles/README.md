# Role pipeline

Канонические промты ролей находятся в этом каталоге. Основной маршрут:

```text
Architect
  → Decomposer
  → Programmer
  → Scanner
  → Task Reviewer
  → Pipeline Service
  → Documentation Auditor
  → Documentation Keeper (только при UPDATE_REQUIRED)
  → Git Integrator
  → Done
```

Условные возвраты:

- `Task Reviewer: NEEDS_FIX` → Programmer;
- `Pipeline Service: failed` → Failure Analyst → Programmer;
- `Documentation Auditor: NO_CHANGES` → Git Integrator;
- архитектурное противоречие на любом этапе → Architect;
- блокер, который нельзя устранить из контекста проекта → User.

| Код роли | Промт |
|---|---|
| `ARCHITECT` | `architect.md` |
| `DECOMPOSER` | `decomposer.md` |
| `PROGRAMMER` | `programmer.md` |
| `SCANNER` | `scanner.md` |
| `TASK_REVIEWER` | `reviewer.md` |
| `PIPELINE_SERVICE` | `tester.md` |
| `FAILURE_ANALYST` | `failure-analyst.md` |
| `DOCUMENTATION_AUDITOR` | `documentation-auditor.md` |
| `DOCUMENTATION_KEEPER` | `documentation-keeper.md` |
| `GIT_INTEGRATOR` | `git-integrator.md` |
