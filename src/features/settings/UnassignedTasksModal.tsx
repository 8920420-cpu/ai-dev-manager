import { useCallback, useEffect, useState } from 'react';
import { Inbox, RefreshCw } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Modal,
  Select,
  useToast,
} from '../../components/ui';
import { tasksApi, type UnassignedTask } from '../../api/tasksApi';
import { projectsApi } from '../../api/projectsApi';
import type { Project } from '../../types/project';
import styles from './UnassignedTasksModal.module.css';

interface UnassignedTasksModalProps {
  open: boolean;
  onClose: () => void;
  /** Вызывается после изменения списка (назначение/обновление) — для счётчика. */
  onChanged?: (count: number) => void;
}

type LoadState = 'loading' | 'error' | 'ready';

/**
 * TASK-INTAKE-UNASSIGNED-001 — «Неразобранные задачи» роли Task Intake Officer.
 * Это задачи без проекта: постановщик не указал/не сопоставил папку проекта.
 * Здесь их назначают на проект вручную; после назначения задача исчезает из
 * списка и уходит по цепочке ролей дальше. Открывается кнопкой на карточке роли.
 */
export function UnassignedTasksModal({ open, onClose, onChanged }: UnassignedTasksModalProps) {
  const toast = useToast();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [tasks, setTasks] = useState<UnassignedTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoadState('loading');
      try {
        const [unassigned, projectList] = await Promise.all([
          tasksApi.unassigned(signal),
          projectsApi.list(signal),
        ]);
        if (signal?.aborted) return;
        setTasks(unassigned.tasks);
        setProjects(projectList);
        setLoadState('ready');
        onChanged?.(unassigned.tasks.length);
      } catch {
        if (signal?.aborted) return;
        setLoadState('error');
      }
    },
    [onChanged],
  );

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [open, load]);

  // Назначить задачу проекту: убираем её из списка и обновляем счётчик.
  const assign = useCallback(
    async (task: UnassignedTask, projectId: string) => {
      const res = await tasksApi.assignProject(task.id, projectId);
      setTasks((prev) => {
        const next = prev.filter((t) => t.id !== task.id);
        onChanged?.(next.length);
        return next;
      });
      toast.success(`Задача назначена проекту «${res.project}» и пошла по цепочке ролей`);
    },
    [onChanged, toast],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Неразобранные задачи"
      subtitle="Задачи без проекта: постановщик не указал папку или она не сопоставилась. Назначьте проект — задача уйдёт по цепочке ролей."
      size="lg"
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw size={15} aria-hidden="true" />}
          onClick={() => void load()}
          disabled={loadState === 'loading'}
        >
          Обновить
        </Button>
      }
      footer={
        <Button variant="primary" onClick={onClose}>
          Закрыть
        </Button>
      }
    >
      {loadState === 'loading' && <LoadingBlock />}

      {loadState === 'error' && (
        <EmptyState
          tone="error"
          icon={<Inbox size={28} aria-hidden="true" />}
          title="Не удалось загрузить неразобранные задачи"
          description="Проверьте подключение к оркестратору и повторите."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {loadState === 'ready' && tasks.length === 0 && (
        <EmptyState
          icon={<Inbox size={28} aria-hidden="true" />}
          title="Неразобранных задач нет"
          description="Все задачи сопоставлены с проектами. Новые без проекта появятся здесь."
        />
      )}

      {loadState === 'ready' && tasks.length > 0 && (
        <ul className={styles.list}>
          {tasks.map((task) => (
            <UnassignedTaskRow
              key={task.id}
              task={task}
              projects={projects}
              onAssign={assign}
            />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function UnassignedTaskRow({
  task,
  projects,
  onAssign,
}: {
  task: UnassignedTask;
  projects: Project[];
  onAssign: (task: UnassignedTask, projectId: string) => Promise<void>;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState('');
  const [assigning, setAssigning] = useState(false);

  async function handleAssign() {
    if (!projectId) return;
    setAssigning(true);
    try {
      await onAssign(task, projectId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось назначить проект');
      setAssigning(false);
    }
  }

  return (
    <li className={styles.row}>
      <div className={styles.info}>
        <span className={styles.title} title={task.title}>
          {task.title}
        </span>
        <div className={styles.meta}>
          <Badge tone="danger">Без проекта</Badge>
          {task.requestedProject && (
            <span className={styles.requested} title="Что прислал постановщик">
              Прислано: {task.requestedProject}
            </span>
          )}
          {task.externalId && <span className={styles.ext}>{task.externalId}</span>}
        </div>
        {task.description && <p className={styles.desc}>{task.description}</p>}
      </div>
      <div className={styles.assign}>
        <Select
          label="Проект"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          disabled={assigning}
        >
          <option value="">— выберите проект —</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          onClick={() => void handleAssign()}
          loading={assigning}
          disabled={!projectId || assigning}
        >
          Назначить
        </Button>
      </div>
    </li>
  );
}
