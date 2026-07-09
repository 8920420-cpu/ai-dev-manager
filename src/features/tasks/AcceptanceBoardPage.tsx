import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, ClipboardCheck, FolderGit2, RefreshCw, RotateCcw } from 'lucide-react';
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
} from '../../components/ui';
import {
  subscribeTaskChanges,
  tasksApi,
  type AcceptanceTask,
  type TaskHistory,
} from '../../api/tasksApi';
import { projectsApi } from '../../api/projectsApi';
import type { Project, Stage } from '../../types/project';
import { taskStatusLabel } from '../../data/taskStatuses';
import { selectAcceptanceRows, type AcceptanceStatusFilter } from './acceptanceRows';
import {
  SELECTABLE_PRIORITIES,
  isOrchestratorPriority,
  taskPriorityLabel,
  taskPriorityTone,
} from '../../data/taskPriorities';
import styles from './AcceptanceBoardPage.module.css';

type LoadState = 'loading' | 'error' | 'ready';

/** Режим доски: очередь приёмки или архив принятых. */
export type AcceptanceMode = 'review' | 'done';

/** Роли, до которых (включительно) можно вернуть задачу на доработку. */
const PROGRAMMER_ROLE = 'PROGRAMMER';
const ARCHITECT_ROLE = 'ARCHITECT';

/**
 * Подразделы «Задачи»: «Проверка» (mode=review) и «Выполнено» (mode=done).
 * Источник — доска приёмки (GET /api/tasks/acceptance-board): задачи, прошедшие
 * конвейер (status=DONE). «Проверка» = ещё не принятые (accepted=false),
 * «Выполнено» = принятые. Таблица Проект · Сервис · Название; клик по задаче
 * открывает карточку с структурой задачи и описанием реализации. В «Проверке» —
 * приём («Принять» → «Выполнено») и возврат на доработку (на выбранный этап).
 */
export function AcceptanceBoardPage({ mode }: { mode: AcceptanceMode }) {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [board, setBoard] = useState<AcceptanceTask[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState<AcceptanceTask | null>(null);
  // Клиентский фильтр по статусу для подраздела «Выполнено» (Все/DONE/CANCELLED).
  const [statusFilter, setStatusFilter] = useState<AcceptanceStatusFilter>('all');

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState('loading');
    try {
      const [boardData, projectList] = await Promise.all([
        tasksApi.acceptanceBoard(signal),
        projectsApi.list(signal),
      ]);
      if (signal?.aborted) return;
      setBoard(boardData.tasks);
      setProjects(projectList);
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

  // Авто-обновление доски при изменениях задач (приём/доработка/новые DONE).
  useEffect(() => {
    return subscribeTaskChanges(() => {
      tasksApi
        .acceptanceBoard()
        .then((data) => setBoard(data.tasks))
        .catch(() => {});
    });
  }, []);

  // «Проверка» — не принятые DONE (без CANCELLED); «Выполнено» — принятые DONE +
  // отменённые, с клиентским фильтром по статусу. Фильтрация без перезагрузки.
  const rows = useMemo(
    () => selectAcceptanceRows(board, mode, statusFilter),
    [board, mode, statusFilter],
  );

  const projectById = useMemo(
    () => new Map(projects.map((p) => [p.id, p])),
    [projects],
  );

  const handleAccepted = useCallback(async () => {
    setSelected(null);
    await load();
  }, [load]);

  // Тихое обновление доски (без индикатора загрузки и без закрытия карточки) —
  // после смены приоритета из карточки, чтобы бейдж в таблице совпал с карточкой.
  const refreshBoard = useCallback(async () => {
    try {
      const data = await tasksApi.acceptanceBoard();
      setBoard(data.tasks);
    } catch {
      /* фоновое обновление: молча игнорируем сбой */
    }
  }, []);

  const title = mode === 'review' ? 'Проверка' : 'Выполнено';
  const description =
    mode === 'review'
      ? 'Задачи, прошедшие весь конвейер ролей и ожидающие приёмки. Откройте задачу, проверьте реализацию и примите её — или верните на доработку.'
      : 'Принятые задачи (прошли проверку). Откройте задачу, чтобы посмотреть структуру и описание реализации.';

  return (
    <div className={styles.page}>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {mode === 'done' && (
              <Select
                label="Статус"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as AcceptanceStatusFilter)}
              >
                <option value="all">Все</option>
                <option value="DONE">Выполнено (DONE)</option>
                <option value="CANCELLED">Отменено (CANCELLED)</option>
              </Select>
            )}
            <Button
              variant="secondary"
              leftIcon={<RefreshCw size={16} aria-hidden="true" />}
              onClick={() => void load()}
              disabled={loadState === 'loading'}
            >
              Обновить
            </Button>
          </>
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

      {loadState === 'ready' && rows.length === 0 && (
        <EmptyState
          icon={
            mode === 'review' ? (
              <ClipboardCheck size={28} aria-hidden="true" />
            ) : (
              <Check size={28} aria-hidden="true" />
            )
          }
          title={mode === 'review' ? 'Очередь проверки пуста' : 'Принятых задач пока нет'}
          description={
            mode === 'review'
              ? 'Сюда попадают задачи, дошедшие до конца конвейера. Когда такая задача появится — примите её здесь.'
              : 'Как только вы примете задачу в разделе «Проверка», она появится здесь.'
          }
        />
      )}

      {loadState === 'ready' && rows.length > 0 && (
        <>
          <p className={styles.summary}>Задач: {rows.length}</p>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Проект</th>
                  <th>Сервис</th>
                  <th>Название</th>
                  <th>Приоритет</th>
                  {mode === 'done' && <th>Статус</th>}
                  {mode === 'done' && <th>Принята</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((task) => (
                  <tr
                    key={task.id}
                    className={styles.row}
                    tabIndex={0}
                    role="button"
                    onClick={() => setSelected(task)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(task);
                      }
                    }}
                  >
                    <td>
                      <span className={styles.projectCell}>
                        <FolderGit2 size={15} aria-hidden="true" className={styles.projectIcon} />
                        {task.projectName}
                      </span>
                    </td>
                    <td className={styles.muted}>{task.serviceName ?? '—'}</td>
                    <td className={styles.titleCell} title={task.title}>
                      {task.title}
                      {task.status === 'CANCELLED' && task.cancelReason && (
                        <span className={styles.cancelReason}>{task.cancelReason}</span>
                      )}
                    </td>
                    <td>
                      <Badge tone={taskPriorityTone(task.priority)}>
                        {taskPriorityLabel(task.priority)}
                      </Badge>
                    </td>
                    {mode === 'done' && (
                      <td>
                        <Badge tone={task.status === 'CANCELLED' ? 'neutral' : 'success'}>
                          {taskStatusLabel(task.status)}
                        </Badge>
                      </td>
                    )}
                    {mode === 'done' && (
                      <td className={styles.muted}>{formatDate(task.acceptedAt)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <TaskAcceptanceModal
        mode={mode}
        task={selected}
        project={selected ? projectById.get(selected.projectId) ?? null : null}
        onClose={() => setSelected(null)}
        onDone={handleAccepted}
        onRefresh={refreshBoard}
      />
    </div>
  );
}

/** Дата ISO → локальная короткая строка (или прочерк). */
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('ru-RU');
}

// --- Карточка задачи: структура + реализация + действия (приём/доработка) -----

interface ImplItem {
  id: string;
  role: string | null;
  status: string | null;
  when: string | null;
  lines: string[];
  files: string[];
}

/**
 * Извлечь из хронологии задачи человекочитаемое описание реализации: что сделала
 * каждая роль (результат программиста, изменённые файлы, резюме/вердикты ролей,
 * коммит/ветка интегратора). События без полезного результата пропускаем.
 */
function buildImplementation(history: TaskHistory | null): ImplItem[] {
  if (!history) return [];
  const items: ImplItem[] = [];
  for (const ev of history.events) {
    const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<
      string,
      unknown
    >;
    const lines: string[] = [];
    const files: string[] = [];

    const pushStr = (v: unknown) => {
      if (typeof v === 'string' && v.trim()) lines.push(v.trim());
    };
    pushStr(p.result);
    pushStr(p.summary);
    pushStr(p.reason);

    const collectFiles = (v: unknown) => {
      if (Array.isArray(v)) {
        for (const f of v) {
          if (typeof f === 'string' && f.trim()) files.push(f.trim());
          else if (f && typeof f === 'object' && typeof (f as { path?: string }).path === 'string') {
            files.push((f as { path: string }).path);
          }
        }
      }
    };
    collectFiles(p.changedFiles);
    const output = p.output && typeof p.output === 'object' ? (p.output as Record<string, unknown>) : null;
    if (output) {
      collectFiles(output.files);
      if (typeof output.commit === 'string' && output.commit.trim())
        lines.push(`Коммит: ${output.commit.trim()}`);
      if (typeof output.branch === 'string' && output.branch.trim())
        lines.push(`Ветка: ${output.branch.trim()}`);
    }

    const status =
      (typeof p.verdictStatus === 'string' && p.verdictStatus) ||
      (typeof p.outcome === 'string' && p.outcome) ||
      null;

    if (lines.length === 0 && files.length === 0 && !status) continue;

    items.push({
      id: ev.id,
      role: ev.actorRoleName ?? ev.nextRoleName ?? null,
      status,
      when: ev.createdAt,
      lines,
      files,
    });
  }
  return items;
}

/** Человекочитаемые подписи частых ключей карточки задачи. */
const CARD_LABELS: Record<string, string> = {
  description: 'Описание',
  affected_services: 'Затронутые сервисы',
  affected_files: 'Затронутые файлы',
  work_items: 'Подзадачи',
  acceptance_criteria: 'Критерии приёмки',
  requestedProject: 'Запрошенный проект',
};

function cardLabel(key: string): string {
  return CARD_LABELS[key] ?? key;
}

/** Значение поля карточки → строка/JSON для отображения. */
function renderCardValue(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function TaskAcceptanceModal({
  mode,
  task,
  project,
  onClose,
  onDone,
  onRefresh,
}: {
  mode: AcceptanceMode;
  task: AcceptanceTask | null;
  project: Project | null;
  onClose: () => void;
  onDone: () => Promise<void> | void;
  /** Тихо обновить доску после смены приоритета (карточку не закрывает). */
  onRefresh?: () => Promise<void> | void;
}) {
  const toast = useToast();
  const [history, setHistory] = useState<TaskHistory | null>(null);
  const [historyState, setHistoryState] = useState<LoadState>('loading');
  const [accepting, setAccepting] = useState(false);
  const [reworkOpen, setReworkOpen] = useState(false);
  // Локальное значение приоритета: карточка сразу отражает смену, не дожидаясь доски.
  const [priority, setPriority] = useState('2');
  const [savingPriority, setSavingPriority] = useState(false);

  // Синхронизируем приоритет с выбранной задачей при открытии/смене задачи.
  useEffect(() => {
    setPriority(task?.priority ?? '2');
  }, [task]);

  const handlePriorityChange = async (next: string) => {
    if (!task || next === priority) return;
    const prev = priority;
    setPriority(next); // оптимистично
    setSavingPriority(true);
    try {
      const res = await tasksApi.setPriority(task.id, Number(next));
      // Сервер может нормализовать значение (напр. форс 0 для оркестратора).
      setPriority(res.priority ?? next);
      toast.success('Приоритет обновлён');
      await onRefresh?.();
    } catch (e) {
      setPriority(prev); // откат при ошибке
      toast.error(e instanceof Error ? e.message : 'Не удалось изменить приоритет');
    } finally {
      setSavingPriority(false);
    }
  };

  // Загрузка структуры и хронологии выбранной задачи.
  useEffect(() => {
    if (!task) return;
    setHistory(null);
    setHistoryState('loading');
    setReworkOpen(false);
    const ctrl = new AbortController();
    tasksApi
      .history(task.id, ctrl.signal)
      .then((data) => {
        if (ctrl.signal.aborted) return;
        setHistory(data);
        setHistoryState('ready');
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setHistoryState('error');
      });
    return () => ctrl.abort();
  }, [task]);

  const dataCard = history?.task?.dataCard ?? null;
  const cardEntries = useMemo(
    () =>
      dataCard
        ? Object.entries(dataCard).filter(([, v]) => v != null && v !== '')
        : [],
    [dataCard],
  );
  const impl = useMemo(() => buildImplementation(history), [history]);

  const handleAccept = async () => {
    if (!task) return;
    setAccepting(true);
    try {
      await tasksApi.accept(task.id);
      toast.success('Задача принята — перенесена в «Выполнено»');
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось принять задачу');
    } finally {
      setAccepting(false);
    }
  };

  return (
    <>
      <Modal
        open={task !== null && !reworkOpen}
        onClose={() => !accepting && onClose()}
        title={task?.title ?? 'Задача'}
        subtitle={
          task
            ? `${task.projectName}${task.serviceName ? ` · ${task.serviceName}` : ''}`
            : undefined
        }
        size="lg"
        footer={
          task ? (
            // Приём/доработка применимы только к DONE-задачам в «Проверке».
            // Для CANCELLED (и в «Выполнено») показываем лишь «Закрыть».
            mode === 'review' && task.status === 'DONE' ? (
              <>
                <Button
                  variant="secondary"
                  onClick={() => setReworkOpen(true)}
                  disabled={accepting}
                  leftIcon={<RotateCcw size={16} aria-hidden="true" />}
                >
                  Доработка
                </Button>
                <Button
                  variant="primary"
                  className={styles.acceptBtn}
                  loading={accepting}
                  onClick={() => void handleAccept()}
                  leftIcon={<Check size={16} aria-hidden="true" />}
                >
                  Принять
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                Закрыть
              </Button>
            )
          ) : undefined
        }
      >
        <div className={styles.detail}>
          <section className={styles.block}>
            <h3 className={styles.blockTitle}>Приоритет</h3>
            {isOrchestratorPriority(priority) ? (
              <p className={styles.muted}>
                <Badge tone={taskPriorityTone(priority)}>{taskPriorityLabel(priority)}</Badge> —
                приоритет задач проекта оркестратора выставляется сервером и не меняется вручную.
              </p>
            ) : (
              <Select
                label="Приоритет"
                value={priority}
                onChange={(e) => void handlePriorityChange(e.target.value)}
                disabled={savingPriority}
              >
                {SELECTABLE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {taskPriorityLabel(p)}
                  </option>
                ))}
              </Select>
            )}
          </section>

          {task && task.status === 'CANCELLED' && (
            <section className={styles.block}>
              <h3 className={styles.blockTitle}>Причина отмены</h3>
              <p className={styles.muted}>
                {task.cancelReason?.trim() ? task.cancelReason : 'Причина отмены не указана.'}
              </p>
              {task.duplicateOf && (
                <p className={styles.muted}>Дубликат задачи: {task.duplicateOf}</p>
              )}
            </section>
          )}

          {historyState === 'loading' && <LoadingBlock label="Загрузка задачи…" />}
          {historyState === 'error' && (
            <Callout tone="error" title="Не удалось загрузить детали задачи" />
          )}
          {historyState === 'ready' && (
            <>
              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Задача</h3>
                {cardEntries.length === 0 ? (
                  <p className={styles.muted}>Структурированных данных по задаче нет.</p>
                ) : (
                  <dl className={styles.card}>
                    {cardEntries.map(([key, value]) => (
                      <div key={key} className={styles.cardRow}>
                        <dt className={styles.cardKey}>{cardLabel(key)}</dt>
                        <dd className={styles.cardVal}>
                          <pre className={styles.pre}>{renderCardValue(value)}</pre>
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </section>

              <section className={styles.block}>
                <h3 className={styles.blockTitle}>Реализация</h3>
                {impl.length === 0 ? (
                  <p className={styles.muted}>
                    Нет описания выполненных работ (роли не оставили результата).
                  </p>
                ) : (
                  <ol className={styles.impl}>
                    {impl.map((item) => (
                      <li key={item.id} className={styles.implItem}>
                        <div className={styles.implHead}>
                          <span className={styles.implRole}>{item.role ?? 'Роль'}</span>
                          {item.status && (
                            <Badge tone="info">{taskStatusLabel(item.status)}</Badge>
                          )}
                          {item.when && (
                            <span className={styles.muted}>{formatDate(item.when)}</span>
                          )}
                        </div>
                        {item.lines.map((line, i) => (
                          <p key={i} className={styles.implLine}>
                            {line}
                          </p>
                        ))}
                        {item.files.length > 0 && (
                          <ul className={styles.files}>
                            {item.files.map((f, i) => (
                              <li key={i} className={styles.file}>
                                {f}
                              </li>
                            ))}
                          </ul>
                        )}
                      </li>
                    ))}
                  </ol>
                )}
              </section>
            </>
          )}
        </div>
      </Modal>

      <ReworkModal
        open={reworkOpen}
        task={task}
        project={project}
        onCancel={() => setReworkOpen(false)}
        onDone={onDone}
      />
    </>
  );
}

// --- Возврат на доработку: «Замечания» + выбор этапа (до программиста включ.) ---

/**
 * Этапы, на которые можно вернуть задачу: только обычные этапы со статусом, не
 * позже этапа программиста (CODING) — т.е. Архитектор/Декомпозитор/Программист и
 * всё, что перед ними. По умолчанию выбран этап Архитектора.
 */
function reworkStages(project: Project | null): { stages: Stage[]; defaultId: string } {
  if (!project) return { stages: [], defaultId: '' };
  const roleCodeById = new Map(project.roles.map((r) => [r.id, r.code]));
  const codesOf = (st: Stage) =>
    st.roleIds.map((id) => roleCodeById.get(id)).filter((c): c is string => Boolean(c));

  const usable = project.stages.filter(
    (s) => (s.kind ?? 'stage') === 'stage' && Boolean(s.taskStatus),
  );
  let cutoff = usable.findIndex((s) => codesOf(s).includes(PROGRAMMER_ROLE));
  if (cutoff === -1) cutoff = usable.length - 1;
  const stages = usable.slice(0, cutoff + 1);

  const architect = stages.find((s) => codesOf(s).includes(ARCHITECT_ROLE));
  const defaultId = architect?.id ?? stages[0]?.id ?? '';
  return { stages, defaultId };
}

function ReworkModal({
  open,
  task,
  project,
  onCancel,
  onDone,
}: {
  open: boolean;
  task: AcceptanceTask | null;
  project: Project | null;
  onCancel: () => void;
  onDone: () => Promise<void> | void;
}) {
  const toast = useToast();
  const { stages, defaultId } = useMemo(() => reworkStages(project), [project]);
  const [toStageId, setToStageId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Сброс формы при открытии на новой задаче (этап по умолчанию — Архитектор).
  useEffect(() => {
    if (open) {
      setToStageId(defaultId);
      setNotes('');
    }
  }, [open, defaultId]);

  const trimmed = notes.trim();

  const handleSubmit = async () => {
    if (!task) return;
    if (!toStageId) {
      toast.error('Выберите этап для возврата');
      return;
    }
    if (!trimmed) {
      toast.error('Заполните замечания');
      return;
    }
    setSaving(true);
    try {
      await tasksApi.move(task.id, { toStageId, reason: trimmed });
      toast.success('Задача возвращена на доработку');
      await onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось вернуть задачу на доработку');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => !saving && onCancel()}
      title="Замечания"
      subtitle={task?.title}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Отмена
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleSubmit()}
            loading={saving}
            disabled={!toStageId || !trimmed}
          >
            Отправить на доработку
          </Button>
        </>
      }
    >
      <div className={styles.reworkForm}>
        <Textarea
          label="Замечания (обязательно)"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={5}
          required
          placeholder="Что нужно доработать"
        />
        <Select
          label="Вернуть на этап"
          value={toStageId}
          onChange={(e) => setToStageId(e.target.value)}
          disabled={saving}
        >
          {stages.length === 0 && <option value="">— нет доступных этапов —</option>}
          {stages.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({taskStatusLabel(s.taskStatus ?? '')})
            </option>
          ))}
        </Select>
        {stages.length === 0 && (
          <p className={styles.muted}>
            У проекта не настроены этапы для возврата (Архитектор … Программист).
          </p>
        )}
      </div>
    </Modal>
  );
}
