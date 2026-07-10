import { useState } from 'react';
import { ExternalLink, Folder, Layers, Pencil, Radar, Trash2, Users } from 'lucide-react';
import { Card, Menu, ProjectStatusBadge, useToast } from '../../components/ui';
import type { MenuItem } from '../../components/ui';
import { projectsApi } from '../../api/projectsApi';
import { countAssignedRoles, isStageEnabled, type Project } from '../../types/project';
import { formatDate, plural } from '../../lib/format';
import { cn } from '../../lib/cn';
import styles from './ProjectCard.module.css';

interface ProjectCardProps {
  project: Project;
  onOpen: (project: Project) => void;
  onEdit: (project: Project) => void;
  onDelete: (project: Project) => void;
  /** Вызывается, когда проект изменён прямо на карточке (тумблер Scanner). */
  onUpdated: (project: Project) => void;
}

/** Карточка подключённого проекта в сетке. */
export function ProjectCard({ project, onOpen, onEdit, onDelete, onUpdated }: ProjectCardProps) {
  const toast = useToast();
  const [scannerPending, setScannerPending] = useState(false);
  const stagesCount = project.stages.length;
  const disabledCount = project.stages.filter((s) => !isStageEnabled(s)).length;
  const rolesCount = countAssignedRoles(project);
  const scannerOn = project.scannerEnabled === true;

  const toggleScanner = async () => {
    if (scannerPending) return;
    const next = !scannerOn;
    setScannerPending(true);
    try {
      const updated = await projectsApi.setScanner(project.id, next);
      onUpdated(updated);
      if (next && !updated.docsPath) {
        toast.info('Scanner включён. Укажите «папку документов» проекта, чтобы приём заработал.');
      } else {
        toast.success(next ? 'Scanner включён: приём задач из папки' : 'Scanner выключен');
      }
    } catch {
      toast.error('Не удалось изменить состояние Scanner');
    } finally {
      setScannerPending(false);
    }
  };

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

      <dl className={styles.meta}>
        <div className={styles.metaItem}>
          <Layers size={15} aria-hidden="true" className={styles.metaIcon} />
          <dt className={styles.srOnly}>Этапы</dt>
          <dd className={styles.metaValue}>
            {stagesCount} {plural(stagesCount, ['этап', 'этапа', 'этапов'])}
            {disabledCount > 0 && (
              <span className={styles.metaMuted}>
                {', '}
                {disabledCount} {plural(disabledCount, ['отключён', 'отключены', 'отключено'])}
              </span>
            )}
          </dd>
        </div>
        <div className={styles.metaItem}>
          <Users size={15} aria-hidden="true" className={styles.metaIcon} />
          <dt className={styles.srOnly}>Назначено ролей</dt>
          <dd className={styles.metaValue}>
            {rolesCount} {plural(rolesCount, ['роль', 'роли', 'ролей'])}
          </dd>
        </div>
      </dl>

      <div className={styles.scannerRow}>
        <button
          type="button"
          role="switch"
          aria-checked={scannerOn}
          className={cn(styles.scannerToggle, scannerOn && styles.scannerOn)}
          onClick={toggleScanner}
          disabled={scannerPending}
          title={
            scannerOn
              ? 'Scanner отслеживает папку проекта и забирает задачи. Нажмите, чтобы выключить.'
              : 'Scanner не отслеживает проект. Нажмите, чтобы включить приём задач из папки.'
          }
        >
          <Radar size={15} aria-hidden="true" />
          <span className={styles.scannerLabel}>Scanner</span>
          <span className={styles.scannerState}>{scannerOn ? 'вкл' : 'выкл'}</span>
        </button>
      </div>

      <div className={styles.footer}>
        <ProjectStatusBadge status={project.status} />
        <span className={styles.updated}>Изменён {formatDate(project.updatedAt)}</span>
      </div>
    </Card>
  );
}
