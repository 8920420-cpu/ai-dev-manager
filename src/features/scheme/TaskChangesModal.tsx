import { useCallback, useEffect, useState } from 'react';
import {
  FileCode2,
  FilePlus2,
  GitCommitHorizontal,
  History,
  RefreshCw,
  UserCog,
} from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Modal,
} from '../../components/ui';
import { taskStatusLabel, taskStatusTone as statusTone } from '../../data/taskStatuses';
import { tasksApi, type TaskHistory, type TaskHistoryEvent } from '../../api/tasksApi';
import styles from './TaskChangesModal.module.css';

interface TaskChangesModalProps {
  open: boolean;
  onClose: () => void;
  /** id задачи, по которой показываем работу ролей. */
  taskId: string | null;
  /** Заголовок задачи (для подзаголовка окна, пока грузятся данные). */
  taskTitle: string;
}

type LoadState = 'loading' | 'error' | 'ready';

// Тон бейджа статуса — общий справочник (data/taskStatuses).

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

/**
 * STAGE-TASKS-002 — что сделала КАЖДАЯ роль по конкретной задаче. Открывается по
 * клику на задачу/подзадачу в дереве «Проект → задача → подзадача». Хронология из
 * task_events: для каждого шага показываем результат работы роли (код/файлы у
 * программиста, коммит у git-интегратора, вердикт у ревью и т.д.). Read-only.
 */
export function TaskChangesModal({ open, onClose, taskId, taskTitle }: TaskChangesModalProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [data, setData] = useState<TaskHistory | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!taskId) return;
      setLoadState('loading');
      try {
        const res = await tasksApi.history(taskId, signal);
        if (signal?.aborted) return;
        setData(res);
        setLoadState('ready');
      } catch {
        if (signal?.aborted) return;
        setLoadState('error');
      }
    },
    [taskId],
  );

  useEffect(() => {
    if (!open || !taskId) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [open, taskId, load]);

  const task = data?.task ?? null;
  const events = data?.events ?? [];
  const subtitle = task
    ? `${task.projectName}${task.projectCode ? ` · ${task.projectCode}` : ''}`
    : taskTitle;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={task?.title || taskTitle || 'Изменения по задаче'}
      subtitle={subtitle}
      size="lg"
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw size={15} aria-hidden="true" />}
          onClick={() => void load()}
          disabled={loadState === 'loading' || !taskId}
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
      {taskId && loadState === 'loading' && <LoadingBlock />}

      {taskId && loadState === 'error' && (
        <EmptyState
          tone="error"
          icon={<History size={28} aria-hidden="true" />}
          title="Не удалось загрузить историю задачи"
          description="Проверьте подключение к оркестратору и повторите."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {taskId && loadState === 'ready' && events.length === 0 && (
        <EmptyState
          icon={<History size={28} aria-hidden="true" />}
          title="По задаче пока нет истории"
          description="Как только роли начнут работать над задачей, здесь появится результат их работы."
        />
      )}

      {taskId && loadState === 'ready' && events.length > 0 && (
        <>
          {task && (
            <div className={styles.taskHead}>
              <Badge tone={statusTone(task.status)}>{taskStatusLabel(task.status)}</Badge>
              <span className={styles.headHint}>Шагов работы ролей: {events.length}</span>
            </div>
          )}
          <ol className={styles.timeline}>
            {events.map((ev) => (
              <EventRow key={ev.id} event={ev} />
            ))}
          </ol>
        </>
      )}
    </Modal>
  );
}

// Заголовок шага: имя роли-исполнителя либо системное событие.
function eventTitle(ev: TaskHistoryEvent): string {
  if (ev.actorRoleName) return ev.actorRoleName;
  if (ev.eventType === 'TASK_CREATED') return 'Задача создана';
  if (ev.eventType === 'AGENT_ASSIGNED') return 'Задача назначена';
  if (ev.eventType === 'TASK_DONE') return 'Завершение';
  if (ev.eventType === 'TASK_BLOCKED') return 'Блокировка';
  return 'Переход';
}

function EventIcon({ ev }: { ev: TaskHistoryEvent }) {
  if (ev.actorRoleCode === 'GIT_INTEGRATOR') return <GitCommitHorizontal size={16} aria-hidden="true" />;
  if (ev.actorRoleCode === 'PROGRAMMER') return <FileCode2 size={16} aria-hidden="true" />;
  if (ev.eventType === 'TASK_CREATED') return <FilePlus2 size={16} aria-hidden="true" />;
  return <UserCog size={16} aria-hidden="true" />;
}

function EventRow({ event: ev }: { event: TaskHistoryEvent }) {
  const time = fmtTime(ev.createdAt);
  const transition =
    ev.fromStatus && ev.toStatus && ev.fromStatus !== ev.toStatus
      ? `${taskStatusLabel(ev.fromStatus)} → ${taskStatusLabel(ev.toStatus)}`
      : ev.toStatus
        ? taskStatusLabel(ev.toStatus)
        : null;

  return (
    <li className={styles.event}>
      <div className={styles.eventDot} aria-hidden="true">
        <EventIcon ev={ev} />
      </div>
      <div className={styles.eventBody}>
        <div className={styles.eventHead}>
          <span className={styles.eventTitle}>{eventTitle(ev)}</span>
          {transition && <span className={styles.transition}>{transition}</span>}
          {time && <span className={styles.eventTime}>{time}</span>}
        </div>
        <EventResult ev={ev} />
      </div>
    </li>
  );
}

/** Результат работы роли на шаге — разбор payload события под конкретную роль. */
function EventResult({ ev }: { ev: TaskHistoryEvent }) {
  const p = (ev.payload ?? {}) as Record<string, unknown>;

  const result = typeof p.result === 'string' ? p.result : null; // программист
  const summary = typeof p.summary === 'string' ? p.summary : null; // AI-роли
  const reason = typeof p.reason === 'string' ? p.reason : null;
  const verdict = typeof p.verdictStatus === 'string' ? p.verdictStatus : null;
  const outcome = typeof p.outcome === 'string' ? p.outcome : null;
  const success = typeof p.success === 'boolean' ? p.success : null;
  const changedFiles = Array.isArray(p.changedFiles)
    ? (p.changedFiles as unknown[]).map(String)
    : [];
  const fields =
    p.fields && typeof p.fields === 'object' ? (p.fields as Record<string, unknown>) : null;

  // Host-роли (git/pipeline) кладут результат в output.
  const output =
    p.output && typeof p.output === 'object' ? (p.output as Record<string, unknown>) : null;
  const commit = output && typeof output.commit === 'string' ? output.commit : null;
  const branch = output && typeof output.branch === 'string' ? output.branch : null;
  const note = output && typeof output.note === 'string' ? output.note : null;
  const outError = output && typeof output.error === 'string' ? output.error : null;
  const outFiles =
    output && Array.isArray(output.files) ? (output.files as unknown[]).map(String) : [];

  // Fork/join и прочие системные пометки.
  const children = Array.isArray(p.children) ? (p.children as unknown[]).length : null;

  const files = changedFiles.length ? changedFiles : outFiles;

  const chips: string[] = [];
  if (verdict) chips.push(`Вердикт: ${verdict}`);
  if (outcome) chips.push(`Исход: ${outcome}`);
  if (success != null) chips.push(success ? 'Успех' : 'Ошибка');

  const hasContent =
    result ||
    summary ||
    reason ||
    commit ||
    note ||
    outError ||
    files.length > 0 ||
    chips.length > 0 ||
    children != null ||
    (fields && Object.keys(fields).length > 0);

  if (!hasContent) {
    return null;
  }

  return (
    <div className={styles.result}>
      {chips.length > 0 && (
        <div className={styles.chips}>
          {chips.map((c) => (
            <span key={c} className={styles.chip}>
              {c}
            </span>
          ))}
        </div>
      )}

      {(result || summary) && <p className={styles.summary}>{result ?? summary}</p>}

      {reason && (
        <p className={styles.line}>
          <span className={styles.key}>Причина:</span> {reason}
        </p>
      )}

      {commit && (
        <p className={styles.line}>
          <span className={styles.key}>Коммит:</span>{' '}
          <code className={styles.code}>{commit.slice(0, 12)}</code>
          {branch ? (
            <>
              {' '}
              <span className={styles.key}>ветка:</span>{' '}
              <code className={styles.code}>{branch}</code>
            </>
          ) : null}
        </p>
      )}

      {note && (
        <p className={styles.line}>
          <span className={styles.key}>Git:</span> {note}
        </p>
      )}

      {outError && <div className={styles.errorBox}>{outError}</div>}

      {files.length > 0 && (
        <div className={styles.files}>
          <span className={styles.key}>Изменённые файлы ({files.length}):</span>
          <ul>
            {files.map((f, i) => (
              <li key={`${f}-${i}`}>
                <code className={styles.code}>{f}</code>
              </li>
            ))}
          </ul>
        </div>
      )}

      {children != null && (
        <p className={styles.line}>
          <span className={styles.key}>Подзадач создано:</span> {children}
        </p>
      )}

      {fields && Object.keys(fields).length > 0 && (
        <dl className={styles.fields}>
          {Object.entries(fields).map(([k, v]) => (
            <div key={k} className={styles.fieldRow}>
              <dt className={styles.key}>{k}</dt>
              <dd className={styles.fieldVal}>{asText(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
