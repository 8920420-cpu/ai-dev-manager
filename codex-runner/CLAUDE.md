# codex-runner — Claude Memory
> Last analyzed: 2026-07-22 (updated)
> Re-analysis needed: NO — read .claude/rules/ files instead of source files

## What this project is
Автоматический исполнитель рассуждающих ролей (Приёмщик/Архитектор/Декомпозитор и пр.), делегированных Codex: опрашивает оркестратор, запускает headless `codex exec` на готовом промпте роли в корне проекта и сдаёт вердикт. Аналог programmer-runner, но для reasoning-ролей и на подписке ChatGPT через локальный Codex CLI.

## Quick reference
- **Stack**: JavaScript
- **Dev**: `node bin/codex-runner.js`
- **Test**: `node --test`
- **Build**: `N/A`

## Memory files (read these, not source files)
- @.claude/rules/architecture.md — folder map, entry points, data flow
- @.claude/rules/stack.md — tech stack, versions, all commands
- @.claude/rules/modules.md — every module and what it does
- @.claude/rules/models.md — DB schemas and data types
- @.claude/rules/api.md — all routes and endpoints
- @.claude/rules/conventions.md — naming, patterns, testing approach
- @.claude/rules/gotchas.md — quirks, workarounds, do-not-touch
- @.claude/rules/changelog.md — what changed and when

## Instruction
You have full codebase knowledge from the files above.
Do NOT re-read source files to understand structure — use memory files.
If something seems outdated, flag it rather than re-analyzing.
