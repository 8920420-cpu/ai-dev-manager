// Канонический маршрут ролей оркестратора как чистая таблица переходов.
// Источник истины для перехода — current_role_id задачи (а не статус): статус
// COMMIT, например, делят между собой финализирующие роли, и различает их роль.
//
// auto:true  — переход выполняет фоновый taskRunner внутри БД.
// auto:false — роль исполняется вне БД (PROGRAMMER = Claude Code + Scanner-мост,
//              SCANNER = файловый сервис). Runner такие задачи не трогает.
//
// from   — статусы, в которых задача легитимно находится под этой ролью;
//          из них runner и принимает её в работу.
// next   — код следующей роли (null = конец маршрута).
// to     — статус, в который переводится задача после успеха роли.
export const ROLE_FLOW = {
  ARCHITECT:             { auto: true,  from: ['BACKLOG', 'READY', 'ARCHITECTURE'], next: 'DECOMPOSER',            to: 'DECOMPOSITION' },
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
