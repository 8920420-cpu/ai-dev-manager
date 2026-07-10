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
  /**
   * Канонический код роли из контракта оркестратора (напр. `SCANNER`,
   * `PROGRAMMER`). Единственный надёжный признак для логики (определение
   * Scanner и т.п.); сравнивать по отображаемому `name` запрещено.
   * Может отсутствовать у пользовательских ролей вне пресетов.
   */
  code?: string;
}

/**
 * Тип узла блок-схемы (FORK-JOIN-001). 'stage' — обычный этап (роль + статус);
 * управляющие узлы: 'fork' (разделить на параллельные ветки), 'join' (объединить
 * ветки барьером), 'condition' (ветвление по исходу).
 */
export type StageKind = 'stage' | 'fork' | 'join' | 'condition';

/** Ребро графа блок-схемы: связь между узлами по стабильному ключу. */
export interface SchemeEdge {
  fromKey: string;
  toKey: string;
  /** Метка ветки для узла condition (исход); null — безусловная связь. */
  condition?: string | null;
  position?: number;
}

/** Этап проекта с назначенными ролями. */
export interface Stage {
  id: string;
  /** Тип узла блок-схемы (по умолчанию 'stage'). */
  kind?: StageKind;
  /** Стабильный ключ узла для ссылок рёбер (UUID); переживает реордер. */
  stageKey?: string;
  /** Для узла fork: ключ парного узла join, снимающего барьер. */
  joinKey?: string;
  name: string;
  /** id назначенных ролей (одна или несколько). */
  roleIds: string[];
  /** Этап включён в пайплайн. Контракт требует явный boolean. */
  enabled: boolean;
  /**
   * Папка, которую отслеживает сканер. Актуально только для этапа с ролью
   * `SCANNER`; для остальных не используется. При смене роли значение не
   * очищается, чтобы при возврате роли его можно было восстановить.
   */
  scanPath?: string;
  /**
   * Статус задач (`task_status`), c которым работает этап Scanner: исполнитель
   * забирает только задачи этого статуса. Актуально лишь для роли `SCANNER`.
   * Среди включённых Scanner-этапов проекта статус должен быть уникален.
   */
  taskStatus?: string;
}

export function isStageEnabled(stage: Pick<Stage, 'enabled'>): boolean {
  return stage.enabled === true;
}

/** Подключённый проект. */
export interface Project {
  id: string;
  name: string;
  /** Абсолютный путь к локальной папке проекта. */
  path: string;
  status: ProjectStatus;
  /**
   * Причина паузы проекта (когда status === 'paused'), напр. рассинхронизация
   * контрактов данных ролей. null — причина не задана/проект не на паузе.
   */
  pauseReason: string | null;
  /**
   * Этапы пайплайна проекта. Задаются НЕ в проекте, а единой «Схемой разработки»
   * (общий конвейер ролей) и материализуются для каждого проекта. Здесь — копия
   * текущей схемы (для отображения в карточке/мониторе).
   */
  stages: Stage[];
  /** Справочник ролей в рамках проекта. */
  roles: Role[];
  /**
   * Абсолютный путь к папке документов проекта («карта» проекта: файлы,
   * описывающие проект). undefined — папка не задана.
   */
  docsPath?: string;
  /**
   * Абсолютный путь к папке задач проекта. За этой папкой следит Scanner этого
   * проекта — из неё принимаются новые задачи. undefined — папка не задана
   * (тогда Scanner откатывается на папку документов).
   */
  tasksPath?: string;
  /**
   * Включён ли автоматический приём задач Scanner из папки документов проекта.
   * true — Scanner следит за папками проекта и сам забирает задачи; false — нет.
   */
  scannerEnabled?: boolean;
  /** ISO-дата последнего изменения. */
  updatedAt: string;
  createdAt: string;
}

/** Полезная нагрузка для создания проекта. */
export interface CreateProjectInput {
  name: string;
  path: string;
  /** Папка документов проекта (необязательно). */
  docsPath?: string;
  /** Папка задач проекта — за ней следит Scanner (необязательно). */
  tasksPath?: string;
}

/** Сводное число назначенных ролей (уникальных) по всем этапам. */
export function countAssignedRoles(project: Pick<Project, 'stages'>): number {
  const set = new Set<string>();
  for (const st of project.stages) for (const r of st.roleIds) set.add(r);
  return set.size;
}
