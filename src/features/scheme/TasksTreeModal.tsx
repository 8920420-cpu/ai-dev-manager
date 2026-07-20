import { useCallback, useEffect, useState } from 'react';
import {
  ChevronRight,
  FolderGit2,
  ListTree,
  RefreshCw,
  SquareCheck,
  Workflow,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Modal,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { taskStatusLabel, taskStatusTone as statusTone } from '../../data/taskStatuses';
import {
  tasksApi,
  type TaskTree,
  type TaskTreeProject,
  type TaskTreeSubtask,
  type TaskTreeTask,
} from '../../api/tasksApi';
import { TaskChangesModal } from './TaskChangesModal';
import styles from './TasksTreeModal.module.css';

interface TasksTreeModalProps {
  open: boolean;
  onClose: () => void;
}

/** Выбранная задача (для окна «что сделала каждая роль»). */
interface SelectedTask {
  id: string;
  title: string;
}

type LoadState = 'loading' | 'error' | 'ready';

// Тон бейджа статуса берём из общего справочника (data/taskStatuses).

/**
 * Модальное дерево задач (read-only). Три уровня: Проект (категория) → Задача
 * (подкатегория) → Подзадача. Узлы сворачиваются/разворачиваются; проекты раскрыты
 * по умолчанию. Клик по строке задачи/подзадачи открывает окно «что сделала каждая
 * роль» ({@link TaskChangesModal}); раскрытие подзадач — отдельной кнопкой-шевроном.
 */
export function TasksTreeModal({ open, onClose }: TasksTreeModalProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [tree, setTree] = useState<TaskTree | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectedTask | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const data = await tasksApi.tree(signal);
      if (signal?.aborted) return;
      setTree(data);
      // Проекты раскрыты по умолчанию — сразу видно структуру.
      setExpanded(new Set(data.projects.map((p) => `p:${p.id}`)));
      setLoadState('ready');
    } catch {
      if (signal?.aborted) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [open, load]);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const totalTasks =
    tree?.projects.reduce((acc, p) => acc + p.taskCount, 0) ?? 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Задачи"
      subtitle="Проект → задача → подзадача"
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
          icon={<ListTree size={28} aria-hidden="true" />}
          title="Не удалось загрузить задачи"
          description="Проверьте подключение к оркестратору и повторите."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {loadState === 'ready' && tree && tree.projects.length === 0 && (
        <EmptyState
          icon={<FolderGit2 size={28} aria-hidden="true" />}
          title="Проектов пока нет"
          description="Добавьте проект — его задачи появятся в этом дереве."
        />
      )}

      {loadState === 'ready' && tree && tree.projects.length > 0 && (
        <>
          <p className={styles.summary}>
            Проектов: {tree.projects.length} · Задач верхнего уровня: {totalTasks}
          </p>
          <ul className={styles.tree} role="tree">
            {tree.projects.map((project) => (
              <ProjectNode
                key={project.id}
                project={project}
                expanded={expanded}
                onToggle={toggle}
                onSelect={setSelected}
              />
            ))}
          </ul>
        </>
      )}

      <TaskChangesModal
        open={selected !== null}
        onClose={() => setSelected(null)}
        taskId={selected?.id ?? null}
        taskTitle={selected?.title ?? ''}
      />
    </Modal>
  );
}

function ProjectNode({
  project,
  expanded,
  onToggle,
  onSelect,
}: {
  project: TaskTreeProject;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (task: SelectedTask) => void;
}) {
  const key = `p:${project.id}`;
  const isOpen = expanded.has(key);
  const hasTasks = project.tasks.length > 0;

  return (
    <li className={styles.node} role="treeitem" aria-expanded={isOpen}>
      <button
        type="button"
        className={cn(styles.row, styles.projectRow)}
        onClick={() => onToggle(key)}
        disabled={!hasTasks}
      >
        <ChevronRight
          size={16}
          className={cn(styles.chevron, isOpen && styles.chevronOpen, !hasTasks && styles.chevronHidden)}
          aria-hidden="true"
        />
        <FolderGit2 size={16} className={styles.projectIcon} aria-hidden="true" />
        <span className={styles.label}>{project.name}</span>
        <span className={styles.count}>{project.taskCount}</span>
      </button>

      {isOpen && hasTasks && (
        <ul className={styles.children} role="group">
          {project.tasks.map((task) => (
            <TaskNode
              key={task.id}
              task={task}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskNode({
  task,
  expanded,
  onToggle,
  onSelect,
}: {
  task: TaskTreeTask;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  onSelect: (task: SelectedTask) => void;
}) {
  const key = `t:${task.id}`;
  const isOpen = expanded.has(key);
  const hasSubs = task.subtasks.length > 0;

  return (
    <li className={styles.node} role="treeitem" aria-expanded={hasSubs ? isOpen : undefined}>
      {/* Шеврон — отдельная кнопка раскрытия; клик по строке открывает детали. */}
      <div className={styles.rowWrap}>
        {hasSubs ? (
          <button
            type="button"
            className={styles.chevronBtn}
            onClick={() => onToggle(key)}
            aria-label={isOpen ? 'Свернуть подзадачи' : 'Раскрыть подзадачи'}
          >
            <ChevronRight
              size={16}
              className={cn(styles.chevron, isOpen && styles.chevronOpen)}
              aria-hidden="true"
            />
          </button>
        ) : (
          <span className={styles.chevronHidden} aria-hidden="true" />
        )}
        <button
          type="button"
          className={styles.openBtn}
          onClick={() => onSelect({ id: task.id, title: task.title })}
          title={`Открыть результат работы ролей: ${task.title}`}
        >
          <Workflow size={15} className={styles.taskIcon} aria-hidden="true" />
          <span className={styles.label} title={task.title}>
            {task.title}
          </span>
          {hasSubs && <span className={styles.count}>{task.subtasks.length}</span>}
          <Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
        </button>
      </div>

      {isOpen && hasSubs && (
        <ul className={styles.children} role="group">
          {task.subtasks.map((sub) => (
            <SubtaskNode key={sub.id} subtask={sub} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SubtaskNode({
  subtask,
  onSelect,
}: {
  subtask: TaskTreeSubtask;
  onSelect: (task: SelectedTask) => void;
}) {
  return (
    <li className={styles.node} role="treeitem">
      <div className={styles.rowWrap}>
        <span className={styles.chevronHidden} aria-hidden="true" />
        <button
          type="button"
          className={styles.openBtn}
          onClick={() => onSelect({ id: subtask.id, title: subtask.title })}
          title={`Открыть результат работы ролей: ${subtask.title}`}
        >
          <SquareCheck size={15} className={styles.subIcon} aria-hidden="true" />
          <span className={styles.label} title={subtask.title}>
            {subtask.title}
          </span>
          <Badge tone={statusTone(subtask.status)}>{taskStatusLabel(subtask.status)}</Badge>
        </button>
      </div>
    </li>
  );
}
