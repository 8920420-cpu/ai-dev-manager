/**
 * Репозиторий проектов.
 * ⚠️ BACKEND_REQUIRED: серверного API проектов пока нет — данные хранятся
 * локально (см. localStore). Интерфейс совместим с будущим REST.
 */
import { createCollectionRepo } from './localStore';
import { makeId } from '../lib/format';
import type { CreateProjectInput, Project, ProjectStatus } from '../types/project';

const repo = createCollectionRepo<Project>('projects');

export const projectsApi = {
  async list(): Promise<Project[]> {
    const items = await repo.list();
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async create(input: CreateProjectInput): Promise<Project> {
    const items = await repo.list();
    const now = new Date().toISOString();
    const project: Project = {
      id: makeId('proj'),
      name: input.name.trim(),
      path: input.path.trim(),
      status: 'active',
      stages: input.stages,
      roles: input.roles,
      databaseId: input.databaseId,
      createdAt: now,
      updatedAt: now,
    };
    await repo.saveAll([project, ...items]);
    return project;
  },

  async update(id: string, patch: Partial<Project>): Promise<Project> {
    const items = await repo.list();
    const idx = items.findIndex((p) => p.id === id);
    if (idx === -1) throw new Error('Проект не найден');
    const updated: Project = {
      ...items[idx]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString(),
    };
    items[idx] = updated;
    await repo.saveAll(items);
    return updated;
  },

  async setStatus(id: string, status: ProjectStatus): Promise<Project> {
    return this.update(id, { status });
  },

  async remove(id: string): Promise<void> {
    const items = await repo.list();
    await repo.saveAll(items.filter((p) => p.id !== id));
  },
};
