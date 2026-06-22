/** Типы проектов, этапов и ролей. */

export type ProjectStatus = 'active' | 'paused' | 'draft' | 'archived';

export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Активен',
  paused: 'На паузе',
  draft: 'Черновик',
  archived: 'В архиве',
};

/** Роль пайплайна (ответственный исполнитель этапа). */
export interface Role {
  id: string;
  /** Отображаемое название, напр. «Разработчик». */
  name: string;
}

/** Этап проекта с назначенными ролями. */
export interface Stage {
  id: string;
  name: string;
  /** id назначенных ролей (одна или несколько). */
  roleIds: string[];
  /**
   * Папка, которую отслеживает сканер. Актуально только для этапа с ролью
   * «Scanner»; для остальных не используется.
   */
  scanPath?: string;
}

/** Подключённый проект. */
export interface Project {
  id: string;
  name: string;
  /** Абсолютный путь к локальной папке проекта. */
  path: string;
  status: ProjectStatus;
  stages: Stage[];
  /** Справочник ролей в рамках проекта. */
  roles: Role[];
  /**
   * id выбранной базы данных (см. databasesApi: PRIMARY_DB_ID для основной
   * PostgreSQL либо id дополнительного подключения).
   */
  databaseId?: string;
  /** ISO-дата последнего изменения. */
  updatedAt: string;
  createdAt: string;
}

/** Полезная нагрузка для создания проекта. */
export interface CreateProjectInput {
  name: string;
  path: string;
  stages: Stage[];
  roles: Role[];
  databaseId?: string;
}

/** Сводное число назначенных ролей (уникальных) по всем этапам. */
export function countAssignedRoles(project: Pick<Project, 'stages'>): number {
  const set = new Set<string>();
  for (const st of project.stages) for (const r of st.roleIds) set.add(r);
  return set.size;
}
