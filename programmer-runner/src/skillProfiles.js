// AGENT-SKILLS-001 — профили скилов для headless-агентов раннера.
//
// Скилы (Claude Code Skills) подаются агенту как ЛОКАЛЬНЫЙ ПЛАГИН `agent-skills`
// в корне репозитория оркестратора: `options.plugins` + белый список
// `options.skills`. Почему не `.claude/skills`: программист работает в worktree
// ЧУЖОГО репозитория, а рассуждающие роли — с `settingSources: []`
// (COLDSTART-MCP-ISOLATION-001), поэтому ни пользовательские, ни проектные скилы
// хоста в этих прогонах не читаются. Плагин подаётся абсолютным путём и потому не
// зависит ни от cwd, ни от настроек машины.
//
// Специализация — ДАННЫМИ, а не ролями (решение 04.08.2026): роль PROGRAMMER
// остаётся одна, а «бэкенд Go / контракт proto / фронтенд Next» различаются полем
// `stack` в задаче. Это не создаёт узлов графа, бэкфилла по проектам и не рвёт KPI
// роли на несравнимые ряды; единица параллелизма остаётся прежней — микросервис
// (WORK-STACK-001 + PROGRAMMER-WORKTREE-PER-SERVICE).
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Имя плагина из agent-skills/.claude-plugin/plugin.json (префикс канонических имён). */
export const PLUGIN_NAME = 'orchestrator-skills';

/** Стеки специализации программиста. */
export const STACKS = ['go', 'proto', 'next'];

// Скилы по стеку. Держим набор узким: в системный промпт попадает фронтматтер
// КАЖДОГО перечисленного скила, и «дать всё на всякий случай» размывает выбор.
const STACK_SKILLS = {
  go: ['go-service-engineer', 'go-test-engineer', 'integration-test-engineer'],
  proto: ['protobuf-contracts', 'grpc-api-design', 'buf-workflow', 'contract-migration-planner'],
  next: ['nextjs-app-router', 'react-component-engineer', 'react-state-management',
    'frontend-ui-engineer', 'frontend-testing', 'nextjs-performance'],
};

// Общие для любой задачи программиста: правки часто задевают права/секреты
// (security-reviewer), схему БД (database-migration-engineer) и диагностируемость
// (observability-engineer) независимо от стека.
const PROGRAMMER_COMMON_SKILLS = [
  'security-reviewer', 'database-migration-engineer', 'observability-engineer',
];

// Скилы рассуждающих ролей. Роли, которых здесь нет (Приёмщик, Router,
// документные), скилов не получают: они не читают код, и лишний фронтматтер им —
// чистый расход контекста.
const ROLE_SKILLS = {
  ARCHITECT: ['system-architect', 'contract-migration-planner', 'database-migration-engineer',
    'protobuf-contracts', 'grpc-api-design', 'test-strategy-planner', 'security-reviewer'],
  MINI_ARCHITECT: ['system-architect', 'test-strategy-planner'],
  TASK_REVIEWER: ['go-code-review', 'frontend-code-review', 'security-reviewer',
    'test-strategy-planner'],
  FAILURE_ANALYST: ['go-test-engineer', 'frontend-testing', 'integration-test-engineer',
    'observability-engineer'],
  GIT_INTEGRATOR: ['release-engineer'],
  REVIEWER: ['go-code-review', 'frontend-code-review', 'security-reviewer'],
  TESTER: ['test-strategy-planner', 'integration-test-engineer'],
  // Инфраструктурный отдел (INFRA-DEPARTMENT-001): те же скилы, что и у dev-ролей,
  // но по домену специалиста. Роли без явной пользы (сеть, виртуализация, бэкапы)
  // профиля не получают.
  INFRA_ARCHITECT: ['system-architect', 'release-engineer', 'observability-engineer'],
  SECURITY_ENGINEER: ['security-reviewer'],
  MONITORING_ENGINEER: ['observability-engineer'],
  SRE_ENGINEER: ['release-engineer', 'observability-engineer'],
  DEVOPS_ENGINEER: ['release-engineer'],
};

/** Нормализация синонимов стека (что могли написать Архитектор/оператор). */
const STACK_ALIASES = new Map([
  ['go', 'go'], ['golang', 'go'], ['backend', 'go'], ['back', 'go'], ['бэкенд', 'go'],
  ['proto', 'proto'], ['protobuf', 'proto'], ['grpc', 'proto'], ['contract', 'proto'],
  ['контракт', 'proto'],
  ['next', 'next'], ['nextjs', 'next'], ['next.js', 'next'], ['react', 'next'],
  ['frontend', 'next'], ['front', 'next'], ['ui', 'next'], ['фронтенд', 'next'],
]);

/**
 * Нормализовать явно заданный стек. Неизвестное значение → null (пусть работает
 * эвристика, а не ошибочный профиль).
 */
export function normalizeStack(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return STACK_ALIASES.get(raw) ?? null;
}

// Сигналы стека в тексте задачи (пути файлов из карточки Архитектора и описания).
// Считаем совпадения и берём максимум: задача «правь .proto и перегенерируй Go»
// должна попасть в proto — контракт первичен, поэтому у него больший вес.
const STACK_SIGNALS = [
  { stack: 'proto', weight: 3, re: /\.proto\b|\bbuf\.(gen\.)?yaml\b|\bprotoc\b|\bgrpc\b/gi },
  { stack: 'go', weight: 1, re: /\.go\b|\bgo\.mod\b|\bgo\.sum\b|\bgofmt\b|\bgo test\b/gi },
  { stack: 'next', weight: 1, re: /\.tsx\b|\.jsx\b|\bnext\.config\b|\bpackage\.json\b|\bnpm (run |test|ci)|\breact\b|\.vue\b|\.css\b/gi },
];

/**
 * Определить стек задачи: явное поле важнее эвристики по тексту (пути файлов из
 * work item Архитектора и описание). Ничего не распознали → null.
 *
 * @param {Object} task задача из claim
 * @returns {'go'|'proto'|'next'|null}
 */
export function detectStack(task = {}) {
  const explicit = normalizeStack(task.stack);
  if (explicit) return explicit;

  const parts = [task.title, task.description];
  if (Array.isArray(task.priorRoleOutputs)) {
    for (const o of task.priorRoleOutputs) {
      parts.push(o?.summary);
      if (Array.isArray(o?.findings)) parts.push(o.findings.join('\n'));
    }
  }
  const text = parts.filter(Boolean).join('\n');
  if (!text) return null;

  const scores = new Map();
  for (const sig of STACK_SIGNALS) {
    const hits = text.match(sig.re);
    if (hits?.length) scores.set(sig.stack, (scores.get(sig.stack) ?? 0) + hits.length * sig.weight);
  }
  if (!scores.size) return null;
  let best = null;
  let bestScore = 0;
  for (const [stack, score] of scores) {
    if (score > bestScore) { best = stack; bestScore = score; }
  }
  return best;
}

/**
 * Набор скилов программиста для стека. Стек не определён → объединение всех
 * стековых наборов: пусть агент выберет сам по описанию, это честнее, чем
 * навязать ему неверный профиль.
 */
export function skillsForStack(stack) {
  const key = normalizeStack(stack);
  const specific = key
    ? STACK_SKILLS[key]
    : STACKS.flatMap((s) => STACK_SKILLS[s]);
  return dedupe([...specific, ...PROGRAMMER_COMMON_SKILLS]);
}

/** Набор скилов рассуждающей роли (пустой — роли, которым скилы не нужны). */
export function skillsForRole(roleCode) {
  const key = String(roleCode ?? '').trim().toUpperCase();
  return dedupe(ROLE_SKILLS[key] ?? []);
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

/** Каноническое имя скила для options.skills (фильтр матчит его точно). */
export function qualify(name) {
  const n = String(name ?? '').trim();
  if (!n) return '';
  return n.includes(':') ? n : `${PLUGIN_NAME}:${n}`;
}

/**
 * Каталог плагина скилов: AGENT_SKILLS_DIR (абсолютный или относительно корня
 * репозитория) → иначе `<repo>/agent-skills` рядом с раннером.
 */
export function resolveSkillsDir(env = process.env) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const override = String(env.AGENT_SKILLS_DIR ?? '').trim();
  if (override) return isAbsolute(override) ? override : resolve(repoRoot, override);
  return join(repoRoot, 'agent-skills');
}

/** Скилы выключены оператором (AGENT_SKILLS=0/false/off). */
function disabled(env) {
  return /^(0|false|off)$/i.test(String(env.AGENT_SKILLS ?? '').trim());
}

/**
 * Опции SDK для набора скилов. Возвращает `{}` (никаких изменений в прогоне), если
 * скилы выключены, каталога плагина нет на диске или набор пуст — раннер обязан
 * деградировать в прежнее поведение, а не падать.
 *
 * @param {string[]} names имена скилов (без префикса плагина или с ним)
 * @param {Object} [env]
 * @returns {{plugins?:Array, skills?:string[]}}
 */
function optionsFor(names, env) {
  if (disabled(env)) return {};
  if (!names.length) return {};
  const dir = resolveSkillsDir(env);
  if (!existsSync(join(dir, '.claude-plugin', 'plugin.json'))) return {};
  return {
    plugins: [{ type: 'local', path: dir, skipMcpDiscovery: true }],
    skills: names.map(qualify),
  };
}

/** Опции SDK для задачи ПРОГРАММИСТА (профиль по стеку). */
export function skillOptionsForStack(stack, env = process.env) {
  return optionsFor(skillsForStack(stack), env);
}

/**
 * Опции SDK для РАССУЖДАЮЩЕЙ роли. Роль без профиля (Приёмщик, Router, пустая) —
 * пустые опции: подсовывать ей программистский набор было бы и бесполезно, и
 * дорого по контексту.
 */
export function skillOptionsForRole(role, env = process.env) {
  return optionsFor(skillsForRole(role), env);
}

/**
 * Подсказка агенту в промпт. Без неё скил остаётся «доступным, но незамеченным»:
 * модель видит фронтматтер, но не считает вызов обязательным шагом.
 */
function hintFor(opts, head) {
  if (!opts.skills?.length) return '';
  return [
    '## Skills',
    head,
    opts.skills.map((s) => `- ${s}`).join('\n'),
    'Load the ones that match what you are about to do BEFORE editing or deciding;'
      + ' they carry this organisation\'s conventions. Skip the irrelevant ones.',
  ].join('\n');
}

/** Подсказка для задачи программиста (с указанием распознанного стека). */
export function skillHintForStack(stack, env = process.env) {
  const key = normalizeStack(stack);
  return hintFor(
    skillOptionsForStack(stack, env),
    key
      ? `Task stack: ${key}. Project engineering skills are available via the Skill tool:`
      : 'Project engineering skills are available via the Skill tool:',
  );
}

/** Подсказка для рассуждающей роли. */
export function skillHintForRole(role, env = process.env) {
  return hintFor(
    skillOptionsForRole(role, env),
    'Project engineering skills are available via the Skill tool:',
  );
}
