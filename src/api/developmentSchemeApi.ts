/**
 * Единая «Схема разработки» — общий конвейер ролей для всех проектов.
 * Контракт: GET/PUT /api/development-scheme (orchestrator developmentScheme.js).
 *
 * Этапы и роли совпадают по форме с проектными (RichStage/Role), поэтому
 * переиспользуем мапперы из projectsApi. У схемы НЕТ папки Scanner — её задаёт
 * каждый проект (papka документов, projects.docs_path).
 */
import { http } from './http';
import { appSettingsApi, type AppSettings } from './appSettingsApi';
import {
  mapStage,
  toStagePayload,
  asStageSaveError,
  type RichStage,
} from './projectsApi';
import type { Role, SchemeEdge, Stage } from '../types/project';

interface RichRole {
  id: string;
  code?: string;
  name: string;
}

interface RichEdge {
  fromKey: string;
  toKey: string;
  condition?: string | null;
  position?: number;
}

interface SchemeResponse {
  stages?: RichStage[];
  roles?: RichRole[];
  edges?: RichEdge[];
}

export interface DevelopmentScheme {
  stages: Stage[];
  roles: Role[];
  /** FORK-JOIN-001: рёбра графа блок-схемы (связи между узлами по stageKey). */
  edges: SchemeEdge[];
}

// --- Health-check маршрута (route-health) ----------------------------------

/**
 * Одна проблема целостности единого маршрута разработки.
 * Контракт бэка: GET /api/development-scheme/route-health.
 * Коды `code`:
 *  - 'role_without_executor'       — роль этапа не входит ни в reasoning-роли,
 *    ни в HOST_ROLES, ни в auto-переходы ROLE_FLOW — этап зависнет;
 *  - 'stage_missing_status'        — этап kind=stage с пустым task_status;
 *  - 'host_role_llm_connector'     — host-роли назначен LLM/reasoning-коннектор;
 *  - 'reasoning_role_no_connector' — reasoning-роль без включённого коннектора;
 *  - 'fork_join_unpaired'          — непарная FORK_GATE/JOIN_GATE graph-нода.
 */
export interface RouteHealthProblem {
  code:
    | 'role_without_executor'
    | 'stage_missing_status'
    | 'host_role_llm_connector'
    | 'reasoning_role_no_connector'
    | 'fork_join_unpaired';
  severity: 'error' | 'warning';
  stageId: string | null;
  stageName: string | null;
  roleCode: string | null;
  message: string;
  recommendation: string;
}

/** Структурированный отчёт health-check единого маршрута разработки. */
export interface RouteHealthReport {
  problems: RouteHealthProblem[];
  summary: { error: number; warning: number; total: number; ok: boolean };
}

function fromResponse(r: SchemeResponse): DevelopmentScheme {
  return {
    stages: (r.stages ?? []).map(mapStage),
    roles: (r.roles ?? []).map((x) => ({ id: x.id, name: x.name, code: x.code })),
    edges: (r.edges ?? []).map((e) => ({
      fromKey: e.fromKey,
      toKey: e.toKey,
      condition: e.condition ?? null,
      position: e.position,
    })),
  };
}

export const developmentSchemeApi = {
  async get(): Promise<DevelopmentScheme> {
    return fromResponse(await http.get<SchemeResponse>('/api/development-scheme'));
  },

  async getRuntime(signal?: AbortSignal): Promise<AppSettings> {
    return appSettingsApi.get(signal);
  },

  async setOrchestratorEnabled(enabled: boolean): Promise<AppSettings> {
    return appSettingsApi.save({ orchestratorEnabled: enabled });
  },

  async save(stages: Stage[], roles: Role[], edges: SchemeEdge[] = []): Promise<DevelopmentScheme> {
    try {
      const body = { stages: toStagePayload(stages, roles), edges };
      return fromResponse(await http.put<SchemeResponse>('/api/development-scheme', body));
    } catch (err) {
      const stageErr = asStageSaveError(err);
      if (stageErr) throw stageErr;
      throw err;
    }
  },

  /** Health-check единого маршрута: структурированный отчёт о тупиках маршрута. */
  async getRouteHealth(): Promise<RouteHealthReport> {
    return http.get<RouteHealthReport>('/api/development-scheme/route-health');
  },
};
