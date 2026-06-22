/**
 * Привязка локального проекта к проекту orchestrator_db по папке (root_path).
 * Папка проекта — ключ связи: задачи проекта в БД видны в мониторе через неё.
 */
import { http } from './http';

export interface DbProject {
  id: string;
  code: string;
  name: string;
  rootPath: string | null;
}

export const dbProjectsApi = {
  /** Зарегистрировать/получить проект БД по папке. Идемпотентно. */
  register(input: { name: string; path: string }): Promise<DbProject> {
    return http.post<DbProject>('/api/projects', input);
  },
  list(): Promise<{ projects: DbProject[] }> {
    return http.get<{ projects: DbProject[] }>('/api/projects');
  },
};
