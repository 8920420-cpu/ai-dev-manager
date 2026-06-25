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
  TASK_INTAKE_OFFICER:   { auto: true,  from: ['BACKLOG', 'READY'],                 next: 'ARCHITECT',             to: 'ARCHITECTURE' },
  ARCHITECT:             { auto: true,  from: ['ARCHITECTURE'],                      next: 'DECOMPOSER',            to: 'DECOMPOSITION' },
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
};

// Роли, которые продвигает фоновый runner внутри БД.
export const AUTO_ROLE_CODES = Object.entries(ROLE_FLOW)
  .filter(([, flow]) => flow.auto)
  .map(([code]) => code);

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
  ARCHITECT:             'design',
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
};

// Тип роли по коду ('' — неизвестная роль).
export function roleKind(code) {
  return ROLE_KINDS[code] ?? '';
}

// Статусы, из которых задачу уже не двигают.
export const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED']);

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
