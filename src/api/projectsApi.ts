/**
 * Репозиторий проектов — канонический REST оркестратора.
 * Контракт: orchestrator-service/backend/db/BUSINESS_STORAGE_CONTRACT.md.
 *
 * Сервер — единственный источник истины: id/code/updatedAt приходят с сервера,
 * в браузере они НЕ генерируются. updatedAt используется как токен optimistic
 * concurrency (PUT возвращает 409 при рассинхронизации).
 */
import { http, ApiError } from './http';
import type {
  CreateProjectInput,
  Project,
  ProjectStatus,
  Role,
  Stage,
  StageKind,
} from '../types/project';

/** Событие изменения списка проектов — чтобы сайдбар мог обновиться. */
export const PROJECTS_CHANGED_EVENT = 'adm-projects-changed';

function emitProjectsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  }
}

// --- Серверный контракт (rich) --------------------------------------------

export interface RichStage {
  id: string;
  name: string;
  enabled?: boolean;
  position?: number;
  roleIds?: string[];
  roleCodes?: string[];
  taskStatus?: string | null;
  scanner?: { watchDirectory?: string; taskStatus?: string | null } | null;
  /** FORK-JOIN-001: тип узла + стабильный ключ + пара fork→join. */
  kind?: StageKind;
  stageKey?: string | null;
  joinKey?: string | null;
}

interface RichRole {
  id: string;
  code?: string;
  name: string;
}

interface RichProject {
  id: string;
  code?: string;
  name: string;
  path?: string;
  /** Алиас path для совместимости с dbProjectsApi. */
  rootPath?: string;
  status?: ProjectStatus;
  /** Причина паузы (когда status === 'paused'). */
  pauseReason?: string | null;
  /** Папка документов проекта («карта»). */
  docsPath?: string | null;
  /** Папка задач проекта (за ней следит Scanner). */
  tasksPath?: string | null;
  /** Включён ли автоприём задач Scanner. */
  scannerEnabled?: boolean;
  stages?: RichStage[];
  roles?: RichRole[];
  createdAt?: string;
  updatedAt?: string;
}

// --- Маппинг сервер → фронт -------------------------------------------------

export function mapStage(stage: RichStage): Stage {
  return {
    id: stage.id,
    kind: stage.kind ?? 'stage',
    stageKey: stage.stageKey ?? undefined,
    joinKey: stage.joinKey ?? undefined,
    name: stage.name,
    roleIds: stage.roleIds ?? [],
    enabled: stage.enabled !== false,
    scanPath: stage.scanner?.watchDirectory || undefined,
    // Статус этапа: плоское поле (единая схема) приоритетнее scanner-блока (проект).
    taskStatus: stage.taskStatus || stage.scanner?.taskStatus || undefined,
  };
}

function mapRole(role: RichRole): Role {
  return { id: role.id, name: role.name, code: role.code };
}

function fromRich(rich: RichProject): Project {
  const now = new Date().toISOString();
  return {
    id: rich.id,
    name: rich.name ?? '',
    path: rich.path ?? rich.rootPath ?? '',
    status: rich.status ?? 'active',
    pauseReason: rich.pauseReason ?? null,
    stages: (rich.stages ?? []).map(mapStage),
    roles: (rich.roles ?? []).map(mapRole),
    docsPath: rich.docsPath ?? undefined,
    tasksPath: rich.tasksPath ?? undefined,
    scannerEnabled: rich.scannerEnabled === true,
    createdAt: rich.createdAt ?? now,
    updatedAt: rich.updatedAt ?? now,
  };
}

// --- Преобразование этапов фронт → сервер (roleIds локальные → roleCodes) ---

/** uuid v4-подобный признак: не локальный wizard-id (stage_xxx / role_xxx). */
function looksLikeUuid(id: string | undefined): id is string {
  return !!id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

interface StagePayload {
  id?: string;
  name: string;
  enabled: boolean;
  scanner: { watchDirectory: string; taskStatus: string };
  roleCodes: string[];
  /** FORK-JOIN-001: тип узла + стабильный ключ + пара fork→join. */
  kind?: StageKind;
  stageKey?: string;
  joinKey?: string;
}

/**
 * Преобразовать wizard-этапы в серверный контракт: локальные roleIds → roleCodes
 * (через справочник ролей input.roles, у пресетных ролей есть code).
 * Локальные id этапов (stage_xxx) на сервер не отправляются — только uuid.
 */
export function toStagePayload(stages: Stage[], roles: Role[]): StagePayload[] {
  const codeById = new Map(roles.map((r) => [r.id, r.code]));
  return stages.map((stage) => {
    const roleCodes = stage.roleIds
      .map((id) => codeById.get(id))
      .filter((code): code is string => Boolean(code));
    const payload: StagePayload = {
      name: stage.name,
      enabled: stage.enabled !== false,
      scanner: { watchDirectory: stage.scanPath ?? '', taskStatus: stage.taskStatus ?? '' },
      roleCodes,
      kind: stage.kind ?? 'stage',
    };
    if (looksLikeUuid(stage.id)) payload.id = stage.id;
    if (stage.stageKey) payload.stageKey = stage.stageKey;
    if (stage.joinKey) payload.joinKey = stage.joinKey;
    return payload;
  });
}

/** Понятная ошибка конфликта optimistic concurrency. */
export class ProjectConflictError extends Error {
  constructor() {
    super('Проект был изменён в другом месте. Данные обновлены — повторите действие.');
    this.name = 'ProjectConflictError';
  }
}

function isConflict(err: unknown): boolean {
  if (err instanceof ApiError && err.status === 409) return true;
  if (err instanceof Error && /project_conflict/i.test(err.message)) return true;
  return false;
}

/** Одна ошибка валидации/согласованности этапов с сервера. */
export interface StageSaveErrorItem {
  /** id этапа (для ошибок валидации этапа). */
  stageId?: string | null;
  /** код роли (для ошибок согласованности контрактов полей). */
  roleCode?: string;
  /** ключ поля (для ошибок согласованности контрактов полей). */
  field?: string;
  code: string;
  message?: string;
}

/**
 * Ошибка сохранения этапов проекта: валидация (`stage_validation_failed`) или
 * несогласованность контрактов полей (`stage_field_inconsistent`). Несёт список
 * детальных ошибок для показа рядом с формой этапов.
 */
export class StageSaveError extends Error {
  code: 'stage_validation_failed' | 'stage_field_inconsistent';
  errors: StageSaveErrorItem[];
  constructor(
    code: 'stage_validation_failed' | 'stage_field_inconsistent',
    errors: StageSaveErrorItem[],
    message?: string,
  ) {
    super(message || code);
    this.name = 'StageSaveError';
    this.code = code;
    this.errors = errors;
  }
}

/** Распознать 422-ошибку сохранения этапов и вернуть типизированную ошибку (или null). */
export function asStageSaveError(err: unknown): StageSaveError | null {
  if (!(err instanceof ApiError) || err.status !== 422) return null;
  const body = err.body as
    | { code?: string; error?: string; errors?: StageSaveErrorItem[] }
    | undefined;
  const code = body?.code;
  if (code === 'stage_validation_failed' || code === 'stage_field_inconsistent') {
    return new StageSaveError(code, body?.errors ?? [], body?.error);
  }
  return null;
}

// --- Health-check маршрута проекта (route-health) --------------------------

/**
 * Одна проблема целостности маршрута проекта.
 * Контракт бэка: GET /api/projects/:projectId/route-health.
 * Известные коды `code`:
 *  - 'role_without_executor'     — роль этапа не входит ни в reasoning-роли,
 *    ни в HOST_ROLES, ни в auto-переходы ROLE_FLOW — этап зависнет;
 *  - 'stage_missing_status'      — этап kind=stage с пустым task_status;
 *  - 'host_role_llm_connector'   — host-роли назначен LLM/reasoning-коннектор;
 *  - 'reasoning_role_no_connector' — reasoning-роль без включённого коннектора;
 *  - 'fork_join_unpaired'        — непарная FORK_GATE/JOIN_GATE graph-нода.
 */
export interface RouteHealthProblem {
  code: string;
  severity: 'error' | 'warning';
  stageId: string | null;
  stageName: string | null;
  roleCode: string | null;
  message: string;
  recommendation: string;
}

/** Структурированный отчёт health-check маршрута проекта. */
export interface RouteHealthReport {
  projectId: string;
  problems: RouteHealthProblem[];
  summary: { error: number; warning: number; total: number; ok: boolean };
}

export const projectsApi = {
  async list(signal?: AbortSignal): Promise<Project[]> {
    // Опции передаём только при наличии signal — иначе вызов остаётся
    // одноаргументным (http.get сам по себе без отмены).
    const { projects } = signal
      ? await http.get<{ projects: RichProject[] }>('/api/projects', { signal })
      : await http.get<{ projects: RichProject[] }>('/api/projects');
    return (projects ?? [])
      .map(fromRich)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async get(id: string): Promise<Project> {
    return fromRich(await http.get<RichProject>(`/api/projects/${encodeURIComponent(id)}`));
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const body = {
      name: input.name.trim(),
      path: input.path.trim(),
      status: 'active' as ProjectStatus,
      docsPath: input.docsPath?.trim() ?? null,
      tasksPath: input.tasksPath?.trim() ?? null,
    };
    const created = fromRich(await http.post<RichProject>('/api/projects', body));
    emitProjectsChanged();
    return created;
  },

  async update(id: string, patch: Partial<Project>): Promise<Project> {
    const body: Record<string, unknown> = {};
    if (patch.name !== undefined) body.name = patch.name.trim();
    if (patch.path !== undefined) body.path = patch.path.trim();
    if (patch.status !== undefined) body.status = patch.status;
    if (patch.docsPath !== undefined) body.docsPath = patch.docsPath?.trim() ?? null;
    if (patch.tasksPath !== undefined) body.tasksPath = patch.tasksPath?.trim() ?? null;
    // Токен optimistic concurrency.
    if (patch.updatedAt !== undefined) body.updatedAt = patch.updatedAt;

    try {
      const updated = fromRich(
        await http.put<RichProject>(`/api/projects/${encodeURIComponent(id)}`, body),
      );
      emitProjectsChanged();
      return updated;
    } catch (err) {
      if (isConflict(err)) throw new ProjectConflictError();
      throw err;
    }
  },

  async setScanner(id: string, enabled: boolean): Promise<Project> {
    const updated = fromRich(
      await http.patch<RichProject>(`/api/projects/${encodeURIComponent(id)}/scanner`, {
        enabled,
      }),
    );
    emitProjectsChanged();
    return updated;
  },

  async setStatus(id: string, status: ProjectStatus): Promise<Project> {
    const updated = fromRich(
      await http.patch<RichProject>(`/api/projects/${encodeURIComponent(id)}/status`, {
        status,
      }),
    );
    emitProjectsChanged();
    return updated;
  },

  async remove(id: string): Promise<void> {
    await http.del(`/api/projects/${encodeURIComponent(id)}`);
    emitProjectsChanged();
  },

  /** Health-check маршрута проекта: структурированный отчёт о тупиках маршрута. */
  async getRouteHealth(id: string): Promise<RouteHealthReport> {
    return http.get<RouteHealthReport>(
      `/api/projects/${encodeURIComponent(id)}/route-health`,
    );
  },
};
