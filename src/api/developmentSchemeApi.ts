/**
 * Единая «Схема разработки» — общий конвейер ролей для всех проектов.
 * Контракт: GET/PUT /api/development-scheme (orchestrator developmentScheme.js).
 *
 * Этапы и роли совпадают по форме с проектными (RichStage/Role), поэтому
 * переиспользуем мапперы из projectsApi. У схемы НЕТ папки Scanner — её задаёт
 * каждый проект (papka документов, projects.docs_path).
 */
import { http } from './http';
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
};
