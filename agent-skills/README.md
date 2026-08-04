# agent-skills — плагин скилов для раннеров (AGENT-SKILLS-001)

Набор инженерных скилов, который headless-раннеры подают агенту через Claude Agent
SDK (`options.plugins` + `options.skills`). Это **локальный плагин Claude Code**:
каталог с манифестом `.claude-plugin/plugin.json` и скилами в `skills/<имя>/SKILL.md`.

## Зачем плагин, а не `.claude/skills` проекта

Раннеры запускают агента с `cwd` = worktree ЦЕЛЕВОГО репозитория (ПС, Smeta, …), а
рассуждающие роли вдобавок работают в режиме полной изоляции настроек
(`settingSources: []` — так лечился 20-секундный холодный старт, см.
COLDSTART-MCP-ISOLATION-001). Ни `~/.claude/skills`, ни `.claude/skills` рабочего
дерева в этом режиме не читаются. Плагин подаётся явным абсолютным путём и потому
не зависит ни от cwd, ни от настроек хоста, а его содержимое версионируется вместе
с оркестратором.

Канонические имена скилов — `orchestrator-skills:<имя каталога>`; раннеры
перечисляют их в `options.skills`, поэтому в системный промпт попадает только
профиль под конкретную задачу, а не все 21 скил.

## Кто это использует

- `programmer-runner/src/claudeAgent.js` — роль PROGRAMMER, профиль по стеку задачи
  (`go` | `proto` | `next`), см. `src/skillProfiles.js`.
- `programmer-runner/src/claudeReasoningAgent.js` — рассуждающие роли (Architect,
  Task Reviewer, Failure Analyst и др.), профиль по коду роли.

Выключатель на оба раннера: `AGENT_SKILLS=0`. Путь к каталогу плагина
переопределяется `AGENT_SKILLS_DIR` (по умолчанию — этот каталог).

## Как добавить скил

1. Создать `skills/<имя>/SKILL.md` с фронтматтером `name` + `description`
   (описание читает модель, решая, грузить ли скил, — пишите его как триггер).
2. Дописать путь в `skills` манифеста `.claude-plugin/plugin.json`.
3. Добавить имя в нужный профиль в `programmer-runner/src/skillProfiles.js`
   (иначе скил останется невидимым: профиль — это белый список).
4. Перезапустить демоны-раннеры (`scripts/start-runners.ps1 -Restart`) — процессы
   долгоживущие и старый код/каталог не перечитывают.
