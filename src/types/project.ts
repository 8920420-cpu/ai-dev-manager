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

/** Этап проекта с назначенными ролями. */
export interface Stage {
  id: string;
  name: string;
  /** id назначенных ролей (одна или несколько). */
  roleIds: string[];
  /**
   * Этап включён в пайплайн. Для новых этапов по умолчанию `true`; старые
   * локальные данные без поля читаются как включённые (см. {@link isStageEnabled}).
   * Отключённый этап остаётся в списке и сохраняет свои настройки.
   */
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

/**
 * Этап считается включённым, если `enabled !== false`. Старые сохранённые данные
 * без поля `enabled` трактуются как включённые.
 */
export function isStageEnabled(stage: Pick<Stage, 'enabled'>): boolean {
  return stage.enabled !== false;
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
   * Абсолютный путь к папке документов проекта («карта» проекта). За этой папкой
   * следит Scanner этого проекта. undefined — папка не задана.
   */
  docsPath?: string;
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
}

/** Сводное число назначенных ролей (уникальных) по всем этапам. */
export function countAssignedRoles(project: Pick<Project, 'stages'>): number {
  const set = new Set<string>();
  for (const st of project.stages) for (const r of st.roleIds) set.add(r);
  return set.size;
}
