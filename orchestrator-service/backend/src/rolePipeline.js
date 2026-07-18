// Канонический маршрут ролей оркестратора как чистая таблица переходов.
//
// PIPELINE-DYNAMIC-ROUTE-001: с переходом на динамический маршрут по этапам
// проекта (см. projectRoute.js) поля next/to из ROLE_FLOW используются ТОЛЬКО
// как КАНОНИЧЕСКИЙ ФОЛБЭК — когда у проекта нет настроенных этапов (project_stages)
// или текущей роли нет в маршруте проекта. Если этапы настроены, соседа и статус
// задаёт порядок этапов конкретного проекта, а не эта таблица.
//
// Источник истины для перехода — current_role_id задачи (а не статус): статус
// COMMIT, например, делят между собой финализирующие роли, и различает их роль.
//
// auto:true  — переход выполняет фоновый taskRunner внутри БД.
// auto:false — роль исполняется вне БД (PROGRAMMER = Claude Code + Scanner-мост,
//              SCANNER = файловый сервис). Runner такие задачи не трогает.
//
// from   — статусы, в которых задача легитимно находится под этой ролью;
//          из них runner и принимает её в работу (канонический фолбэк).
// next   — код следующей роли (null = конец маршрута) — канонический фолбэк.
// to     — статус, в который переводится задача после успеха роли — фолбэк.
export const ROLE_FLOW = {
  // Приёмщик задач — первая роль: классифицирует входящий запрос и готовит карточку.
  // Задачи приходят либо из Scanner (intake из папки), либо из модального окна.
  // TASK-ROUTER-001: после Приёмщика идёт Task Router (лёгкий триаж), а не сразу
  // Архитектор. В граф-режиме (все реальные проекты) развилку задаёт условное ребро;
  // здесь next=TASK_ROUTER — КАНОНИЧЕСКИЙ фолбэк для проектов без графа.
  TASK_INTAKE_OFFICER:   { auto: true,  from: ['BACKLOG', 'READY'],                 next: 'TASK_ROUTER',           to: 'ARCHITECTURE' },
  // TASK-ROUTER-001: Task Router — лёгкая роль-триаж после Приёмщика. Выбирает контур
  // small|medium|large. Реальная развилка (small → MINI_ARCHITECT, иначе → ARCHITECT)
  // выражена УСЛОВНЫМИ рёбрами графа (project_stage_edges.condition); здесь next —
  // безопасный фолбэк на полного Архитектора (medium/large-контур).
  TASK_ROUTER:           { auto: true,  from: ['ARCHITECTURE'],                      next: 'ARCHITECT',             to: 'ARCHITECTURE' },
  // MINI_ARCHITECT — облегчённый архитектор для route=small: без разведки и без
  // расщепления, короткий work item и сразу к Программисту.
  MINI_ARCHITECT:        { auto: true,  from: ['ARCHITECTURE'],                      next: 'PROGRAMMER',            to: 'CODING' },
  // DECOMPOSER-REMOVE-001: Декомпозитор выведен из маршрута — Архитектор передаёт
  // задачу прямо Программисту (service_id гарантирует финализация Архитектора в
  // db.js, см. ensureArchitectService). Роль DECOMPOSER сохранена в roles/ROLE_FLOW
  // как off-route фолбэк для легаси-задач, ещё стоящих под ней (DECOMPOSITION).
  ARCHITECT:             { auto: true,  from: ['ARCHITECTURE'],                      next: 'PROGRAMMER',            to: 'CODING' },
  DECOMPOSER:            { auto: true,  from: ['DECOMPOSITION'],                     next: 'PROGRAMMER',            to: 'CODING' },
  // Реализацию пишет Claude Code; завершение возвращает Scanner-мост (REVIEW).
  PROGRAMMER:            { auto: false, from: ['CODING'],                            next: 'TASK_REVIEWER',         to: 'REVIEW' },
  // Файловый сервис, в маршруте runner не участвует.
  SCANNER:               { auto: false, from: ['CODING'],                            next: 'TASK_REVIEWER',         to: 'REVIEW' },
  TASK_REVIEWER:         { auto: true,  from: ['REVIEW'],                            next: 'PIPELINE_SERVICE',      to: 'TESTING' },
  PIPELINE_SERVICE:      { auto: true,  from: ['TESTING'],                           next: 'DOCUMENTATION_AUDITOR', to: 'COMMIT' },
  FAILURE_ANALYST:       { auto: true,  from: ['FAILURE_ANALYSIS'],                  next: 'PROGRAMMER',            to: 'CODING' },
  DOCUMENTATION_AUDITOR: { auto: true,  from: ['COMMIT'],                            next: 'GIT_INTEGRATOR',        to: 'COMMIT' },
  DOCUMENTATION_KEEPER:  { auto: true,  from: ['COMMIT'],                            next: 'GIT_INTEGRATOR',        to: 'COMMIT' },
  GIT_INTEGRATOR:        { auto: true,  from: ['COMMIT'],                            next: null,                    to: 'DONE' },

  // INFRA-DEPARTMENT-001 — Инфраструктурный отдел: отдельный конвейер для инфра-задач
  // (маршрут ведёт ГРАФ project_stages инфра-проекта с fork/join). Роли исполняются
  // теми же движками, что и разработка: reasoning-роли на драйверах claude_code/codex
  // (auto:true, как ARCHITECT/TASK_REVIEWER — их не трогает внутренний DeepSeek-цикл,
  // а захватывает хостовый драйвер по role_connectors), финальный commit — общий
  // GIT_INTEGRATOR (host). Поля next/to — КАНОНИЧЕСКИЙ ФОЛБЭК (в графе их задаёт
  // порядок/рёбра этапов). Статусы переиспользуют enum task_status без новых значений:
  //   INFRA_ARCHITECT(ARCHITECTURE) → 7 исполнителей(CODING) → гейты(REVIEW) →
  //   мониторинг(TESTING) → GIT_INTEGRATOR(COMMIT) → DONE.
  INFRA_ARCHITECT:         { auto: true, from: ['ARCHITECTURE'], next: 'SYSADMIN',            to: 'CODING' },
  SYSADMIN:                { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  DEVOPS_ENGINEER:         { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  NETWORK_ENGINEER:        { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  K8S_ENGINEER:            { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  DOCKER_ENGINEER:         { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  VIRTUALIZATION_ENGINEER: { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  BACKUP_ENGINEER:         { auto: true, from: ['CODING'],       next: 'SECURITY_ENGINEER',   to: 'REVIEW' },
  SECURITY_ENGINEER:       { auto: true, from: ['REVIEW'],       next: 'SRE_ENGINEER',        to: 'REVIEW' },
  SRE_ENGINEER:            { auto: true, from: ['REVIEW'],       next: 'MONITORING_ENGINEER', to: 'TESTING' },
  MONITORING_ENGINEER:     { auto: true, from: ['TESTING'],      next: 'GIT_INTEGRATOR',      to: 'COMMIT' },
};

// Роли, которые продвигает фоновый runner внутри БД.
export const AUTO_ROLE_CODES = Object.entries(ROLE_FLOW)
  .filter(([, flow]) => flow.auto)
  .map(([code]) => code);

// ROLE-NO-EXECUTOR-001: множество кодов ролей, у которых ЕСТЬ исполнитель.
// Критерий исполнимости — наличие роли в ROLE_FLOW: auto-роли ведёт runner в БД;
// PROGRAMMER/SCANNER исполняются через мосты (Claude Code / файловый сервис);
// host-роли PIPELINE_SERVICE/GIT_INTEGRATOR тоже входят в ROLE_FLOW; все
// LLM-роли ⊂ ROLE_FLOW. Роль вне ROLE_FLOW никто не подхватит — задача на её
// этапе зависнет.
export const EXECUTABLE_ROLE_CODES = new Set(Object.keys(ROLE_FLOW));

// Есть ли у роли исполнитель (⇔ роль присутствует в ROLE_FLOW).
export function roleHasExecutor(code) {
  return EXECUTABLE_ROLE_CODES.has(code);
}

// Классификация ролей по ТИПУ (PIPELINE-DYNAMIC-ROUTE-001). Тип не зависит от
// положения роли в маршруте проекта — он нужен, чтобы динамический резолвер мог
// находить цель ВЕТВЛЕНИЯ (доработка/документация/архитектура) по типу роли
// внутри этапов конкретного проекта, а не по жёстко зашитому соседу:
//   executor   — роль-исполнитель, к которой возвращается доработка (REWORK);
//   gate       — гейт качества (ревью): провал уводит на анализ/доработку;
//   analyst    — диагност падения, возвращающий задачу исполнителю;
//   auditor    — аудитор документации (ветвится по статусу вердикта);
//   dockeeper  — обновляет документацию;
//   design     — проектные роли (архитектура/декомпозиция);
//   integrator — финализация (git);
//   scanner    — файловый мост; pipeline — прогон проверок; deploy — деплой;
//   structure  — поддержка структуры проекта.
export const ROLE_KINDS = {
  STRUCTURE_KEEPER:      'structure',
  TASK_INTAKE_OFFICER:   'intake',
  // TASK-ROUTER-001: 'router' — нейтральный тип (не executor/design/analyst): триаж
  // не является целью REWORK/BRANCH и не пропускается forward-логикой как аналитик.
  TASK_ROUTER:           'router',
  ARCHITECT:             'design',
  // MINI_ARCHITECT — тоже проектная роль (design): облегчённый архитектор small-контура.
  MINI_ARCHITECT:        'design',
  DECOMPOSER:            'design',
  PROGRAMMER:            'executor',
  SCANNER:               'scanner',
  TASK_REVIEWER:         'gate',
  REVIEWER:              'gate',
  PIPELINE_SERVICE:      'pipeline',
  TESTER:                'pipeline',
  FAILURE_ANALYST:       'analyst',
  DOCUMENTATION_AUDITOR: 'auditor',
  DOCUMENTATION_KEEPER:  'dockeeper',
  GIT_INTEGRATOR:        'integrator',
  COMMITTER:             'integrator',
  DEPLOYER:              'deploy',
  // FORK-JOIN-001: синтетические узлы блок-схемы. 'gate' — НЕ 'analyst', чтобы
  // forward их не пропускал; ими владеют подметатели advanceForkNodes/JoinNodes,
  // а не runner (роли скрыты, hidden=true → claimLlmRoleTask их не клеймит).
  FORK_GATE:             'gate',
  JOIN_GATE:             'gate',

  // INFRA-DEPARTMENT-001 — типы ролей Инфраструктурного отдела (для ветвления
  // динамического резолвера в инфра-графе): архитектор — проектная роль (design),
  // семь доменных исполнителей — executor (к ним возвращается REWORK гейтов),
  // ИБ/SRE — гейты качества (провал → доработка исполнителю), мониторинг — проверка
  // (pipeline, как TESTER). Финальный commit ведёт общий GIT_INTEGRATOR (integrator).
  INFRA_ARCHITECT:         'design',
  SYSADMIN:                'executor',
  DEVOPS_ENGINEER:         'executor',
  NETWORK_ENGINEER:        'executor',
  K8S_ENGINEER:            'executor',
  DOCKER_ENGINEER:         'executor',
  VIRTUALIZATION_ENGINEER: 'executor',
  BACKUP_ENGINEER:         'executor',
  SECURITY_ENGINEER:       'gate',
  SRE_ENGINEER:            'gate',
  MONITORING_ENGINEER:     'pipeline',
};

// Тип роли по коду ('' — неизвестная роль).
export function roleKind(code) {
  return ROLE_KINDS[code] ?? '';
}

// Статусы, из которых задачу уже не двигают.
export const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED']);

// TASK-ROUTER-001 — контур маршрута, который выбирает Task Router: small|medium|large.
// Значения совпадают с task_size (триаж Приёмщика), но route — ГЛАВНОЕ решение после
// Router (task_size остаётся вспомогательным hint/наблюдаемостью). Отсутствие/мусор →
// medium (безопасный дефолт: полный Архитектор). Единый нормализатор — чтобы roleEngine
// (метка ветки графа) и db (запись в карточку) трактовали значение одинаково.
export const TASK_ROUTES = ['small', 'medium', 'large'];
export function normalizeTaskRoute(value, dflt = 'medium') {
  const s = String(value ?? '').trim().toLowerCase();
  return TASK_ROUTES.includes(s) ? s : dflt;
}

/**
 * Чистый переход роли: что делать с задачей, которой владеет роль roleCode.
 * Возвращает { nextRole, toStatus, done } или null, если роль неизвестна/не auto.
 */
export function nextTransition(roleCode) {
  const flow = ROLE_FLOW[roleCode];
  if (!flow || !flow.auto) return null;
  return { nextRole: flow.next, toStatus: flow.to, done: flow.next === null };
}

/**
 * Пропуск скрытых ролей (ROLE-CONFIGURATION-001). Начиная с предложенного
 * перехода (nextRole + toStatus), «проматывает» подряд идущие скрытые роли так,
 * как если бы каждая успешно прошла свой штатный переход (to/next), НЕ запуская
 * её исполнителя. Это переводит задачу к первой следующей АКТИВНОЙ роли.
 *
 * isHidden — предикат (roleCode) => boolean (источник — флаг roles.hidden).
 * Возвращает { nextRole, toStatus, done, skipped[] }:
 *   * nextRole — первая активная роль маршрута (или null, если их больше нет);
 *   * toStatus — статус, в который переходит задача (учитывает to пропущенных);
 *   * done     — маршрут завершён (скрыта последняя роль) → терминальный статус;
 *   * skipped  — коды пропущенных скрытых ролей по порядку.
 * Защищено от зацикливания числом известных ролей.
 */
export function fastForwardHiddenRoles(nextRole, toStatus, isHidden) {
  const skipped = [];
  let role = nextRole ?? null;
  let status = toStatus;
  const guard = Object.keys(ROLE_FLOW).length + 1;
  let steps = 0;
  while (role && typeof isHidden === 'function' && isHidden(role) && steps < guard) {
    const flow = ROLE_FLOW[role];
    skipped.push(role);
    if (!flow) {
      // Неизвестная скрытая роль: дальше маршрута нет — завершаем.
      role = null;
      break;
    }
    status = flow.to;
    role = flow.next;
    steps += 1;
  }
  return { nextRole: role ?? null, toStatus: status, done: !role, skipped };
}
