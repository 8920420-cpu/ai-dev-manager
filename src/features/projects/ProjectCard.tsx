import { ExternalLink, Folder, Pencil, Trash2 } from 'lucide-react';
import { Card, Menu, ProjectStatusBadge } from '../../components/ui';
import type { MenuItem } from '../../components/ui';
import type { Project } from '../../types/project';
import { formatDate } from '../../lib/format';
import styles from './ProjectCard.module.css';

interface ProjectCardProps {
  project: Project;
  onOpen: (project: Project) => void;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
}

/** Карточка подключённого проекта в сетке. */
export function ProjectCard({ project, onOpen, onEdit, onDelete }: ProjectCardProps) {
  const menuItems: MenuItem[] = [
    {
      label: 'Открыть',
      icon: <ExternalLink size={16} aria-hidden="true" />,
      onSelect: () => onOpen(project),
    },
    {
      label: 'Изменить',
      icon: <Pencil size={16} aria-hidden="true" />,
      onSelect: () => onEdit(project),
    },
    {
      label: 'Удалить',
      icon: <Trash2 size={16} aria-hidden="true" />,
      tone: 'danger',
      onSelect: () => onDelete(project),
    },
  ];

  return (
    <Card className={styles.card} aria-label={`Проект ${project.name}`}>
      <div className={styles.head}>
        <h3 className={styles.name} title={project.name}>
          <button
            type="button"
            className={styles.nameBtn}
            onClick={() => onOpen(project)}
            aria-label={`Открыть монитор задач проекта ${project.name}`}
          >
            {project.name}
          </button>
        </h3>
        <div className={styles.menu}>
          <Menu items={menuItems} label={`Действия для проекта ${project.name}`} />
        </div>
      </div>

      <p className={styles.path} title={project.path}>
        <Folder size={15} aria-hidden="true" className={styles.pathIcon} />
        <span className={styles.pathText}>{project.path}</span>
      </p>

      <div className={styles.footer}>
        <ProjectStatusBadge status={project.status} />
        <span className={styles.updated}>Изменён {formatDate(project.updatedAt)}</span>
      </div>
    </Card>
  );
}
