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
} from '../types/project';

/** Событие изменения списка проектов — чтобы сайдбар мог обновиться. */
export const PROJECTS_CHANGED_EVENT = 'adm-projects-changed';

function emitProjectsChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  }
}

// --- Серверный контракт (rich) --------------------------------------------

interface RichStage {
  id: string;
  name: string;
  enabled?: boolean;
  position?: number;
  roleIds?: string[];
  roleCodes?: string[];
  scanner?: { watchDirectory?: string } | null;
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
  databaseId?: string | null;
  stages?: RichStage[];
  roles?: RichRole[];
  createdAt?: string;
  updatedAt?: string;
}

// --- Маппинг сервер → фронт -------------------------------------------------

function mapStage(stage: RichStage): Stage {
  return {
    id: stage.id,
    name: stage.name,
    roleIds: stage.roleIds ?? [],
    enabled: stage.enabled !== false,
    scanPath: stage.scanner?.watchDirectory || undefined,
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
    stages: (rich.stages ?? []).map(mapStage),
    roles: (rich.roles ?? []).map(mapRole),
    databaseId: rich.databaseId ?? undefined,
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
  scanner: { watchDirectory: string };
  roleCodes: string[];
}

/**
 * Преобразовать wizard-этапы в серверный контракт: локальные roleIds → roleCodes
 * (через справочник ролей input.roles, у пресетных ролей есть code).
 * Локальные id этапов (stage_xxx) на сервер не отправляются — только uuid.
 */
function toStagePayload(stages: Stage[], roles: Role[]): StagePayload[] {
  const codeById = new Map(roles.map((r) => [r.id, r.code]));
  return stages.map((stage) => {
    const roleCodes = stage.roleIds
      .map((id) => codeById.get(id))
      .filter((code): code is string => Boolean(code));
    const payload: StagePayload = {
      name: stage.name,
      enabled: stage.enabled !== false,
      scanner: { watchDirectory: stage.scanPath ?? '' },
      roleCodes,
    };
    if (looksLikeUuid(stage.id)) payload.id = stage.id;
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

export const projectsApi = {
  async list(): Promise<Project[]> {
    const { projects } = await http.get<{ projects: RichProject[] }>('/api/projects');
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
      databaseId: input.databaseId ?? null,
      stages: toStagePayload(input.stages, input.roles),
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
    if (patch.databaseId !== undefined) body.databaseId = patch.databaseId ?? null;
    if (patch.stages !== undefined) {
      body.stages = toStagePayload(patch.stages, patch.roles ?? []);
    }
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
};
