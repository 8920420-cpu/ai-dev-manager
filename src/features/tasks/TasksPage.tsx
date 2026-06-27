import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronRight,
  FolderGit2,
  MoveRight,
  RefreshCw,
  RotateCcw,
  SquareCheck,
  Workflow,
} from 'lucide-react';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  LoadingBlock,
  Modal,
  PageHeader,
  Select,
  Textarea,
  useToast,
  type BadgeTone,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { taskStatusLabel } from '../../data/taskStatuses';
import {
  subscribeTaskChanges,
  tasksApi,
  type TaskTree,
  type TaskTreeProject,
  type TaskTreeSubtask,
  type TaskTreeTask,
} from '../../api/tasksApi';
import { projectsApi } from '../../api/projectsApi';
import type { Project, Stage } from '../../types/project';
import { countTopLevelTasks, filterTaskTree } from './filterTaskTree';
import styles from './TasksPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

// Статусы, из которых задача автоматически не двигается (нужно ручное перемещение).
const TERMINAL_STATUSES = new Set(['DONE', 'CANCELLED', 'FAILED']);

/** Можно ли продвинуть задачу «на следующий этап» автоматически. */
export function canAdvance(status: string): boolean {
  return !TERMINAL_STATUSES.has(status) && status !== 'BLOCKED';
}

function statusTone(status: string): BadgeTone {
  if (status === 'DONE') return 'success';
  if (status === 'BLOCKED' || status === 'FAILED' || status === 'CANCELLED') return 'danger';
  if (status === 'RESTART') return 'warning';
  if (status === 'READY' || status === 'BACKLOG') return 'neutral';
  return 'info';
}

/** Цель ручного перемещения — выбранная задача и её проект. */
interface MoveTarget {
  taskId: string;
  title: string;
  projectId: string;
  status: string;
}

/** Действия над строкой задачи (общие для задач и подзадач). */
interface RowActions {
  projectId: string;
  busyId: string | null;
  onAdvance: (taskId: string) => void;
  onMove: (target: MoveTarget) => void;
}

/**
 * Раздел «Задачи»: самостоятельная страница с деревом проект → задача → подзадача
 * (контракт /api/tasks/tree). По умолчанию скрывает выполненные (DONE); переключатель
 * «Показать выполненные» возвращает их. В строке задачи — «Перенести на следующий
 * этап» (авто) и «Переместить» (ручной выбор этапа, в т.ч. для BLOCKED).
 */
export function TasksPage() {
  const toast = useToast();
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [tree, setTree] = useState<TaskTree | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [showDone, setShowDone] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const [treeData, projectList] = await Promise.all([
        tasksApi.tree(signal),
        projectsApi.list(signal),
      ]);
      if (signal?.aborted) return;
      setTree(treeData);
      setProjects(projectList);
      setExpanded(new Set(treeData.projects.map((p) => `p:${p.id}`)));
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [load]);

  // Авто-обновление дерева при изменениях задач (события оркестратора).
  useEffect(() => {
    return subscribeTaskChanges(() => {
      tasksApi
        .tree()
        .then((data) => setTree(data))
        .catch(() => {});
    });
  }, []);

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const displayed = useMemo(
    () => (tree ? filterTaskTree(tree, showDone) : null),
    [tree, showDone],
  );

  // Этапы по проекту для модалки ручного перемещения (только узлы-этапы со статусом).
  const stagesByProject = useMemo(() => {
    const map = new Map<string, Stage[]>();
    for (const p of projects) {
      map.set(
        p.id,
        p.stages.filter((s) => (s.kind ?? 'stage') === 'stage' && Boolean(s.taskStatus)),
      );
    }
    return map;
  }, [projects]);

  const handleAdvance = useCallback(
    async (taskId: string) => {
      setBusyId(taskId);
      try {
        const res = await tasksApi.advance(taskId);
        toast.success(
          res.done
            ? 'Задача завершена (конец маршрута)'
            : `Задача переведена: ${taskStatusLabel(res.toStatus)}`,
        );
        await load();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось продвинуть задачу');
      } finally {
        setBusyId(null);
      }
    },
    [load, toast],
  );

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    try {
      const res = await tasksApi.restartStuck();
      toast.success(
        res.restarted > 0
          ? `Перезапущено задач: ${res.restarted} — переданы Приёмщику задач`
          : 'Зависших задач не найдено',
      );
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось перезапустить задачи');
    } finally {
      setRestarting(false);
    }
  }, [load, toast]);

  const rowActions: RowActions = {
    projectId: '',
    busyId,
    onAdvance: (id) => void handleAdvance(id),
    onMove: (target) => setMoveTarget(target),
  };

  const totalTopLevel = displayed ? countTopLevelTasks(displayed) : 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Задачи"
        description="Дерево проект → задача → подзадача. Выполненные скрыты по умолчанию. Задачу можно перенести на следующий этап маршрута или переместить вручную (для заблокированных)."
        actions={
          <div className={styles.headerActions}>
            <label className={styles.toggle}>
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
              />
              Показать выполненные
            </label>
            <Button
              variant="secondary"
              leftIcon={<RotateCcw size={16} aria-hidden="true" />}
              loading={restarting}
              disabled={loadState !== 'ready'}
              onClick={() => void handleRestart()}
              title="Перевести все зависшие задачи в статус «Перезапуск» — их сразу заберёт Приёмщик задач"
            >
              Перезапустить
            </Button>
            <Button
              variant="secondary"
              leftIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void load()}
              disabled={loadState === 'loading'}
            >
              Обновить
            </Button>
          </div>
        }
      />

      {loadState === 'loading' && <LoadingBlock label="Загрузка задач…" />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить задачи">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && displayed && displayed.projects.length === 0 && (
        <EmptyState
          icon={<FolderGit2 size={28} aria-hidden="true" />}
          title="Проектов пока нет"
          description="Добавьте проект — его задачи появятся в этом дереве."
        />
      )}

      {loadState === 'ready' && displayed && displayed.projects.length > 0 && (
        <>
          <p className={styles.summary}>
            Проектов: {displayed.projects.length} · Задач верхнего уровня
            {showDone ? '' : ' (без выполненных)'}: {totalTopLevel}
          </p>
          <ul className={styles.tree} role="tree">
            {displayed.projects.map((project) => (
              <ProjectNode
                key={project.id}
                project={project}
                expanded={expanded}
                onToggle={toggle}
                actions={rowActions}
              />
            ))}
          </ul>
        </>
      )}

      <MoveModal
        target={moveTarget}
        stages={moveTarget ? stagesByProject.get(moveTarget.projectId) ?? [] : []}
        onClose={() => setMoveTarget(null)}
        onMoved={async () => {
          setMoveTarget(null);
          await load();
        }}
      />
    </div>
  );
}

function ProjectNode({
  project,
  expanded,
  onToggle,
  actions,
}: {
  project: TaskTreeProject;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  actions: RowActions;
}) {
  const key = `p:${project.id}`;
  const isOpen = expanded.has(key);
  const hasTasks = project.tasks.length > 0;
  const childActions: RowActions = { ...actions, projectId: project.id };

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
            <TaskNode key={task.id} task={task} expanded={expanded} onToggle={onToggle} actions={childActions} />
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
  actions,
}: {
  task: TaskTreeTask;
  expanded: Set<string>;
  onToggle: (key: string) => void;
  actions: RowActions;
}) {
  const key = `t:${task.id}`;
  const isOpen = expanded.has(key);
  const hasSubs = task.subtasks.length > 0;

  return (
    <li className={styles.node} role="treeitem" aria-expanded={hasSubs ? isOpen : undefined}>
      <div className={styles.rowWrap}>
        {hasSubs ? (
          <button
            type="button"
            className={styles.chevronBtn}
            onClick={() => onToggle(key)}
            aria-label={isOpen ? 'Свернуть подзадачи' : 'Раскрыть подзадачи'}
          >
            <ChevronRight size={16} className={cn(styles.chevron, isOpen && styles.chevronOpen)} aria-hidden="true" />
          </button>
        ) : (
          <span className={styles.chevronHidden} aria-hidden="true" />
        )}
        <Workflow size={15} className={styles.taskIcon} aria-hidden="true" />
        <span className={styles.label} title={task.title}>
          {task.title}
        </span>
        {hasSubs && <span className={styles.count}>{task.subtasks.length}</span>}
        <Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
        <TaskRowActions
          taskId={task.id}
          title={task.title}
          status={task.status}
          actions={actions}
        />
      </div>

      {isOpen && hasSubs && (
        <ul className={styles.children} role="group">
          {task.subtasks.map((sub) => (
            <SubtaskNode key={sub.id} subtask={sub} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}

function SubtaskNode({ subtask, actions }: { subtask: TaskTreeSubtask; actions: RowActions }) {
  return (
    <li className={styles.node} role="treeitem">
      <div className={styles.rowWrap}>
        <span className={styles.chevronHidden} aria-hidden="true" />
        <SquareCheck size={15} className={styles.subIcon} aria-hidden="true" />
        <span className={styles.label} title={subtask.title}>
          {subtask.title}
        </span>
        <Badge tone={statusTone(subtask.status)}>{taskStatusLabel(subtask.status)}</Badge>
        <TaskRowActions
          taskId={subtask.id}
          title={subtask.title}
          status={subtask.status}
          actions={actions}
        />
      </div>
    </li>
  );
}

function TaskRowActions({
  taskId,
  title,
  status,
  actions,
}: {
  taskId: string;
  title: string;
  status: string;
  actions: RowActions;
}) {
  const busy = actions.busyId === taskId;
  return (
    <span className={styles.rowActions}>
      {canAdvance(status) && (
        <Button
          variant="secondary"
          size="sm"
          leftIcon={<ArrowRight size={14} aria-hidden="true" />}
          loading={busy}
          onClick={() => actions.onAdvance(taskId)}
        >
          Дальше
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        leftIcon={<MoveRight size={14} aria-hidden="true" />}
        disabled={busy}
        onClick={() => actions.onMove({ taskId, title, projectId: actions.projectId, status })}
      >
        Переместить
      </Button>
    </span>
  );
}

function MoveModal({
  target,
  stages,
  onClose,
  onMoved,
}: {
  target: MoveTarget | null;
  stages: Stage[];
  onClose: () => void;
  onMoved: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [toStageId, setToStageId] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  // Сброс полей при открытии на новой задаче.
  useEffect(() => {
    setToStageId('');
    setReason('');
  }, [target?.taskId]);

  const handleMove = async () => {
    if (!target) return;
    if (!toStageId) {
      toast.error('Выберите целевой этап');
      return;
    }
    setSaving(true);
    try {
      const res = await tasksApi.move(target.taskId, { toStageId, reason: reason.trim() || undefined });
      toast.success(`Задача перемещена: ${taskStatusLabel(res.toStatus)}`);
      await onMoved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось переместить задачу');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={target !== null}
      onClose={() => !saving && onClose()}
      title="Переместить задачу"
      subtitle={target?.title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Отмена
          </Button>
          <Button variant="primary" onClick={() => void handleMove()} loading={saving}>
            Переместить
          </Button>
        </>
      }
    >
      <div className={styles.moveForm}>
        <p className={styles.moveHint}>
          Текущий статус: <strong>{target ? taskStatusLabel(target.status) : ''}</strong>. Ручное
          перемещение запишет событие в историю задачи (источник «manual») и снимет текущего
          исполнителя.
        </p>
        <Select
          label="Целевой этап"
          value={toStageId}
          onChange={(e) => setToStageId(e.target.value)}
          disabled={saving}
        >
          <option value="">— выберите этап —</option>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({taskStatusLabel(s.taskStatus ?? '')})
            </option>
          ))}
        </Select>
        {stages.length === 0 && (
          <p className={styles.moveHint}>У проекта нет настроенных этапов для перемещения.</p>
        )}
        <Textarea
          label="Причина / комментарий (необязательно)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="Зачем перемещаем задачу вручную"
        />
      </div>
    </Modal>
  );
}
