import { useState } from 'react';
import { PauseCircle, Play } from 'lucide-react';
import { Button, useToast } from '../../components/ui';
import { projectsApi } from '../../api/projectsApi';
import type { Project } from '../../types/project';
import styles from './ProjectPauseBanner.module.css';

interface ProjectPauseBannerProps {
  project: Project;
  /** Обновлённый проект после снятия паузы передаётся родителю. */
  onResumed: (project: Project) => void;
}

/**
 * Предупреждающий баннер паузы проекта: показывается, когда status === 'paused'.
 * Выводит причину паузы (pauseReason) и кнопку «Снять паузу» (PATCH status
 * active). После успеха родитель получает обновлённый проект.
 */
export function ProjectPauseBanner({ project, onResumed }: ProjectPauseBannerProps) {
  const toast = useToast();
  const [resuming, setResuming] = useState(false);

  if (project.status !== 'paused') return null;

  async function handleResume() {
    setResuming(true);
    try {
      const updated = await projectsApi.setStatus(project.id, 'active');
      onResumed(updated);
      toast.success('Пауза снята — проект снова активен');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось снять паузу');
      setResuming(false);
    }
  }

  return (
    <div className={styles.banner} role="alert">
      <span className={styles.icon}>
        <PauseCircle size={20} aria-hidden="true" />
      </span>
      <div className={styles.body}>
        <p className={styles.title}>Проект на паузе</p>
        <p className={styles.reason}>
          {project.pauseReason?.trim() ||
            'Причина не указана. Проверьте согласованность контрактов данных ролей.'}
        </p>
      </div>
      <Button
        variant="primary"
        size="sm"
        leftIcon={<Play size={16} aria-hidden="true" />}
        onClick={() => void handleResume()}
        loading={resuming}
      >
        Снять паузу
      </Button>
    </div>
  );
}
