/**
 * Лёгкая шина «открыть монитор проекта»: сайдбар вне дерева страницы проектов,
 * поэтому клик по проекту в меню сообщает странице, какой проект открыть, через
 * глобальное событие (тот же приём, что и PROJECTS_CHANGED_EVENT для меню).
 */
export const OPEN_PROJECT_MONITOR_EVENT = 'adm-open-project-monitor';

export interface OpenProjectMonitorDetail {
  projectId: string;
}

/** Попросить страницу проектов открыть монитор конкретного проекта. */
export function requestOpenProjectMonitor(projectId: string): void {
  window.dispatchEvent(
    new CustomEvent<OpenProjectMonitorDetail>(OPEN_PROJECT_MONITOR_EVENT, {
      detail: { projectId },
    }),
  );
}
