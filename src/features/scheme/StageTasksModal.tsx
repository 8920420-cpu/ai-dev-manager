import { useCallback, useEffect, useState } from 'react';
import { ListTree, RefreshCw, Workflow } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Modal,
  type BadgeTone,
} from '../../components/ui';
import { cn } from '../../lib/cn';
import { taskStatusLabel } from '../../data/taskStatuses';
import { tasksApi, type StageTask, type StageTaskRun, type StageTasks } from '../../api/tasksApi';
import styles from './StageTasksModal.module.css';

interface StageTasksModalProps {
  open: boolean;
  onClose: () => void;
  /** id роли этапа (global_stage_roles.role_id) — по нему ищем задачи и результат. */
  roleId: string | null;
  /** Название этапа (для подзаголовка окна). */
  stageName: string;
}

type LoadState = 'loading' | 'error' | 'ready';

// Тон бейджа статуса задачи: завершённые — успех, проблемные — опасность.
function taskStatusTone(status: string): BadgeTone {
  if (status === 'DONE') return 'success';
  if (status === 'BLOCKED' || status === 'FAILED' || status === 'CANCELLED') return 'danger';
  if (status === 'READY' || status === 'BACKLOG') return 'neutral';
  return 'info';
}

// Тон бейджа статуса запуска роли (agent_run_status).
function runStatusTone(status: string): BadgeTone {
  if (status === 'SUCCESS') return 'success';
  if (status === 'FAILED' || status === 'TIMEOUT' || status === 'CANCELLED') return 'danger';
  return 'info';
}

const RUN_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Ожидает',
  RUNNING: 'Выполняется',
  SUCCESS: 'Успех',
  FAILED: 'Ошибка',
  TIMEOUT: 'Таймаут',
  CANCELLED: 'Отменён',
};

function fmtDuration(ms: number | null): string | null {
  if (ms == null || ms < 0) return null;
  if (ms < 1000) return `${ms} мс`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return `${m} мин ${s % 60} с`;
}

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * STAGE-TASKS-001 — задачи, прошедшие через конкретный этап схемы, и результат,
 * который этот этап (роль) внёс в каждую задачу. Открывается по кнопке «Задачи»
 * на карточке этапа в блок-схеме «Схемы разработки». Read-only.
 */
export function StageTasksModal({ open, onClose, roleId, stageName }: StageTasksModalProps) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [data, setData] = useState<StageTasks | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (!roleId) return;
      setLoadState('loading');
      try {
        const res = await tasksApi.byStage(roleId, signal);
        if (signal?.aborted) return;
        setData(res);
        setLoadState('ready');
      } catch {
        if (signal?.aborted) return;
        setLoadState('error');
      }
    },
    [roleId],
  );

  useEffect(() => {
    if (!open || !roleId) return;
    const ctrl = new AbortController();
    void load(ctrl.signal);
    return () => ctrl.abort();
  }, [open, roleId, load]);

  const tasks = data?.tasks ?? [];
  const subtitle = data?.role
    ? `${stageName} · роль «${data.role.name}»`
    : stageName;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Задачи этапа"
      subtitle={subtitle}
      size="lg"
      footerStart={
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<RefreshCw size={15} aria-hidden="true" />}
          onClick={() => void load()}
          disabled={loadState === 'loading' || !roleId}
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
      {!roleId && (
        <EmptyState
          icon={<ListTree size={28} aria-hidden="true" />}
          title="У этапа не выбрана роль"
          description="Назначьте роль этапу — тогда здесь появятся задачи, прошедшие через него."
        />
      )}

      {roleId && loadState === 'loading' && <LoadingBlock />}

      {roleId && loadState === 'error' && (
        <EmptyState
          tone="error"
          icon={<ListTree size={28} aria-hidden="true" />}
          title="Не удалось загрузить задачи этапа"
          description="Проверьте подключение к оркестратору и повторите."
          action={
            <Button variant="secondary" onClick={() => void load()}>
              Повторить
            </Button>
          }
        />
      )}

      {roleId && loadState === 'ready' && tasks.length === 0 && (
        <EmptyState
          icon={<Workflow size={28} aria-hidden="true" />}
          title="Через этот этап ещё не проходила ни одна задача"
          description="Как только задача пройдёт этот этап, здесь появится результат, который он внёс."
        />
      )}

      {roleId && loadState === 'ready' && tasks.length > 0 && (
        <>
          <p className={styles.summary}>Задач прошло через этап: {tasks.length}</p>
          <ul className={styles.taskList}>
            {tasks.map((task) => (
              <TaskCard key={task.taskId} task={task} />
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

function TaskCard({ task }: { task: StageTask }) {
  return (
    <li className={styles.taskCard}>
      <div className={styles.taskHead}>
        <Workflow size={16} className={styles.taskIcon} aria-hidden="true" />
        <span className={styles.taskTitle} title={task.title}>
          {task.title}
        </span>
        <Badge tone={taskStatusTone(task.taskStatus)}>{taskStatusLabel(task.taskStatus)}</Badge>
      </div>
      <p className={styles.projectMeta}>
        {task.projectName}
        {task.projectCode ? ` · ${task.projectCode}` : ''}
      </p>

      <ul className={styles.runList}>
        {task.runs.map((run, i) => (
          <RunRow key={run.runId} run={run} latest={i === 0} multiple={task.runs.length > 1} />
        ))}
      </ul>
    </li>
  );
}

function RunRow({
  run,
  latest,
  multiple,
}: {
  run: StageTaskRun;
  latest: boolean;
  multiple: boolean;
}) {
  const time = fmtTime(run.finishedAt ?? run.startedAt);
  const duration = fmtDuration(run.durationMs);
  const cost = run.cost > 0 ? run.cost.toFixed(4) : null;
  const tokens = run.tokenInput + run.tokenOutput;

  return (
    <li className={cn(styles.run, latest && multiple && styles.runLatest)}>
      <div className={styles.runHead}>
        <Badge tone={runStatusTone(run.status)}>
          {RUN_STATUS_LABEL[run.status] ?? run.status}
        </Badge>
        {multiple && latest && <span className={styles.latestTag}>последний запуск</span>}
        <span className={styles.runMeta}>
          {time}
          {duration ? ` · ${duration}` : ''}
        </span>
      </div>

      <ResultBody run={run} />

      {(tokens > 0 || cost) && (
        <p className={styles.runFooter}>
          {tokens > 0 ? `Токены: ${tokens.toLocaleString('ru-RU')}` : ''}
          {tokens > 0 && cost ? ' · ' : ''}
          {cost ? `Стоимость: $${cost}` : ''}
        </p>
      )}
    </li>
  );
}

// Известные ключи output, которые отображаем отдельными блоками. Остальные ключи
// (кроме служебных) показываем как пары «ключ: значение» в общем списке полей.
const KNOWN_KEYS = new Set([
  'summary',
  'outcome',
  'status',
  'reason',
  'findings',
  'fields',
  'via',
  'nextRole',
  'success',
]);

function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v, null, 2);
}

/** Отрисовка результата запуска: ошибка, либо разобранный output роли. */
function ResultBody({ run }: { run: StageTaskRun }) {
  if (run.error) {
    return <div className={styles.errorBox}>{run.error}</div>;
  }

  const out = run.output ?? {};
  const summary = typeof out.summary === 'string' ? out.summary : null;
  const outcome = typeof out.outcome === 'string' ? out.outcome : null;
  const verdict = typeof out.status === 'string' ? out.status : null;
  const reason = typeof out.reason === 'string' ? out.reason : null;
  const findings = out.findings;
  const fields = (out.fields && typeof out.fields === 'object'
    ? (out.fields as Record<string, unknown>)
    : null);

  // Прочие (нестандартные) ключи output — для host-ролей и расширений.
  const extra = Object.entries(out).filter(([k, v]) => !KNOWN_KEYS.has(k) && v != null);

  const findingsList = Array.isArray(findings)
    ? findings.filter((f) => f != null).map((f) => asText(f))
    : typeof findings === 'string' && findings.trim()
      ? [findings]
      : [];

  const hasAny =
    summary || outcome || verdict || reason || findingsList.length > 0 ||
    (fields && Object.keys(fields).length > 0) || extra.length > 0;

  if (!hasAny) {
    return <p className={styles.noResult}>Этап не оставил структурированного результата.</p>;
  }

  return (
    <div className={styles.result}>
      {(outcome || verdict) && (
        <div className={styles.chips}>
          {verdict && <span className={styles.chip}>Вердикт: {verdict}</span>}
          {outcome && <span className={styles.chip}>Исход: {outcome}</span>}
        </div>
      )}

      {summary && <p className={styles.resultSummary}>{summary}</p>}

      {reason && (
        <p className={styles.resultReason}>
          <span className={styles.fieldKey}>Причина:</span> {reason}
        </p>
      )}

      {findingsList.length > 0 && (
        <div className={styles.findings}>
          <span className={styles.fieldKey}>Замечания:</span>
          <ul>
            {findingsList.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}

      {fields && Object.keys(fields).length > 0 && (
        <dl className={styles.fields}>
          {Object.entries(fields).map(([k, v]) => (
            <div key={k} className={styles.fieldRow}>
              <dt className={styles.fieldKey}>{k}</dt>
              <dd className={styles.fieldVal}>{asText(v)}</dd>
            </div>
          ))}
        </dl>
      )}

      {extra.length > 0 && (
        <dl className={styles.fields}>
          {extra.map(([k, v]) => (
            <div key={k} className={styles.fieldRow}>
              <dt className={styles.fieldKey}>{k}</dt>
              <dd className={styles.fieldVal}>{asText(v)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
