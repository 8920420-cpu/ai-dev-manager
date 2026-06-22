import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers, Settings } from 'lucide-react';
import {
  Badge,
  Button,
  EmptyState,
  LoadingBlock,
  Select,
  type BadgeTone,
} from '../../components/ui';
import { taskStatisticsApi } from '../../api/taskStatisticsApi';
import { dbProjectsApi } from '../../api/dbProjectsApi';
import { ApiError } from '../../api/http';
import { formatDateTime, formatDuration, formatTime } from '../../lib/format';
import type { Project } from '../../types/project';
import type { TaskStatRow, TaskStatistics } from '../../types/taskStats';
import styles from './ProjectMonitor.module.css';

interface ProjectMonitorProps {
  project: Project;
  /** Закрыть монитор и вернуться к списку проектов. */
  onBack: () => void;
  /** Открыть настройки проекта (редактирование). Если не задан — кнопка скрыта. */
  onEdit?: (project: Project) => void;
  /** id для aria-controls (раскрываемый/экранный вариант). */
  regionId?: string;
}

const PAGE_SIZE = 20;
const AUTO_REFRESH_MS = 5000;

type LoadState = 'loading' | 'error' | 'ready';
type SortKey = 'default' | 'stage' | 'status' | 'duration';

const STATUS_LABEL: Record<string, string> = {
  BACKLOG: 'Бэклог',
  READY: 'Готова к работе',
  ARCHITECTURE: 'Архитектура',
  DECOMPOSITION: 'Декомпозиция',
  CODING: 'Разработка',
  TESTING: 'Пайплайн и тесты',
  FAILURE_ANALYSIS: 'Анализ сбоя',
  REVIEW: 'Ревью',
  COMMIT: 'Коммит',
  DEPLOY: 'Деплой',
  DONE: 'Завершено',
  BLOCKED: 'Заблокировано',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
};

const STATUS_TONE: Record<string, BadgeTone> = {
  DONE: 'success',
  BLOCKED: 'danger',
  FAILED: 'danger',
  CANCELLED: 'neutral',
  REVIEW: 'info',
  TESTING: 'info',
  CODING: 'primary',
  ARCHITECTURE: 'primary',
  DECOMPOSITION: 'primary',
};

function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}
function statusTone(status: string): BadgeTone {
  return STATUS_TONE[status] ?? 'neutral';
}

// Пайплайн ролей: роль → этап(ы), на которых она ответственна. Код этапа
// совпадает с stageCode из summary.byStage (см. backend taskStats.STAGE_BY_STATUS).
// Несколько этапов на роль (COMMIT+DEPLOY) суммируются.
const ROLE_PIPELINE: { name: string; stages: string[]; tone: BadgeTone }[] = [
  { name: 'Архитектор', stages: ['ARCHITECTURE'], tone: 'primary' },
  { name: 'Декомпозер', stages: ['DECOMPOSITION'], tone: 'primary' },
  { name: 'Разработчик', stages: ['CODING'], tone: 'primary' },
  { name: 'Тестировщик', stages: ['TESTING'], tone: 'info' },
  { name: 'Аналитик сбоев', stages: ['FAILURE_ANALYSIS'], tone: 'warning' },
  { name: 'Ревьюер', stages: ['REVIEW'], tone: 'info' },
  { name: 'Git-интегратор', stages: ['COMMIT', 'DEPLOY'], tone: 'success' },
];

// Этапы вне зоны ответственности ролей — показываем сводной строкой «Очередь».
const QUEUE_STAGES = ['BACKLOG', 'READY'];

interface RoleStat {
  name: string;
  stageLabel: string;
  count: number;
  tone: BadgeTone;
}

// Свести byStage (по всему проекту) к строкам «по ролям».
function buildRoleStats(byStage: Record<string, number>): RoleStat[] {
  return ROLE_PIPELINE.map((role) => ({
    name: role.name,
    stageLabel: role.stages.map((s) => statusLabel(s)).join(' · '),
    count: role.stages.reduce((acc, s) => acc + (byStage[s] ?? 0), 0),
    tone: role.tone,
  }));
}

type ViewMode = 'tasks' | 'roles';

// Длительность активной задачи растёт относительно момента загрузки данных
// (нельзя завязываться на часы браузера vs сервера — берём elapsed с fetch).
function liveDuration(
  base: number | null,
  active: boolean,
  elapsedSinceFetch: number,
): number | null {
  if (base == null) return null;
  return active ? base + elapsedSinceFetch : base;
}

export function ProjectMonitor({ project, onBack, onEdit, regionId = 'project-monitor' }: ProjectMonitorProps) {
  const [data, setData] = useState<TaskStatistics | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [offset, setOffset] = useState(0);

  const [filterStage, setFilterStage] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('default');
  const [view, setView] = useState<ViewMode>('roles');

  // Метка момента получения данных (для тика активных длительностей) и «сейчас».
  const [fetchedAt, setFetchedAt] = useState(0);
  const [nowTick, setNowTick] = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  // Идентификатор проекта в БД (UUID), полученный привязкой по папке.
  const [apiId, setApiId] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  // Привязка по папке: регистрируем/получаем проект БД по project.path.
  useEffect(() => {
    let cancelled = false;
    setApiId(null);
    setLoadState('loading');
    dbProjectsApi
      .register({ name: project.name, path: project.path })
      .then((p) => {
        if (!cancelled) setApiId(p.id);
      })
      .catch(() => {
        // Бэкенд недоступен/без папки — пробуем резолв по пути напрямую.
        if (!cancelled) setApiId(project.path || project.id);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id, project.name, project.path]);

  const load = useCallback(
    async (nextOffset: number, silent = false) => {
      if (!apiId) return;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      if (!silent) setLoadState('loading');
      try {
        const res = await taskStatisticsApi.get(apiId, {
          limit: PAGE_SIZE,
          offset: nextOffset,
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        setData(res);
        setFetchedAt(Date.now());
        setNowTick(Date.now());
        setLastUpdated(res.generatedAt);
        setLoadState('ready');
      } catch (err) {
        if (ctrl.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          return; // устаревший запрос — игнорируем
        }
        const msg =
          err instanceof ApiError && err.status === 404
            ? `Проект не привязан к orchestrator_db по папке «${project.path}». Задачи появятся, когда оркестратор создаст их для этого проекта.`
            : err instanceof ApiError
              ? err.message
              : 'Не удалось загрузить статистику задач.';
        setErrorMsg(msg);
        setLoadState('error');
      }
    },
    [apiId, project.path],
  );

  // Первичная загрузка и перезагрузка при смене страницы (после привязки).
  useEffect(() => {
    if (apiId) void load(offset);
    return () => abortRef.current?.abort();
  }, [load, offset, apiId]);

  // Сбрасываем страницу/фильтры при переключении проекта.
  useEffect(() => {
    setOffset(0);
    setFilterStage('');
    setFilterStatus('');
    setSortKey('default');
  }, [project.id]);

  // Автообновление, только пока монитор открыт и вкладка видима.
  useEffect(() => {
    if (!apiId) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(offset, true);
    }, AUTO_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load(offset, true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load, offset, apiId]);

  // Тик «сейчас» раз в секунду для роста активных длительностей (данные не меняем).
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const elapsedSinceFetch = Math.max(0, nowTick - fetchedAt);

  const rows = data?.tasks ?? [];

  // Опции фильтров из текущей страницы.
  const stageOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.stageCode, r.stageName);
    return [...m.entries()];
  }, [rows]);
  const statusOptions = useMemo(() => {
    return [...new Set(rows.map((r) => r.status))];
  }, [rows]);

  const visibleRows = useMemo(() => {
    let out = rows.filter(
      (r) =>
        (!filterStage || r.stageCode === filterStage) &&
        (!filterStatus || r.status === filterStatus),
    );
    if (sortKey !== 'default') {
      out = [...out].sort((a, b) => {
        if (sortKey === 'stage') return a.stageName.localeCompare(b.stageName, 'ru');
        if (sortKey === 'status') return statusLabel(a.status).localeCompare(statusLabel(b.status), 'ru');
        // duration: по общему времени, по убыванию (null — в конец)
        const av = a.totalDurationMs ?? -1;
        const bv = b.totalDurationMs ?? -1;
        return bv - av;
      });
    }
    return out;
  }, [rows, filterStage, filterStatus, sortKey]);

  const summary = data?.summary;
  const roleStats = useMemo(
    () => (summary ? buildRoleStats(summary.byStage ?? {}) : []),
    [summary],
  );
  const queueCount = useMemo(
    () =>
      summary
        ? QUEUE_STAGES.reduce((acc, s) => acc + (summary.byStage?.[s] ?? 0), 0)
        : 0,
    [summary],
  );
  const total = data?.pagination.total ?? 0;
  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + PAGE_SIZE, total);

  return (
    <section className={styles.monitor} id={regionId} aria-label={`Монитор задач проекта ${project.name}`}>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <Button variant="ghost" size="sm" onClick={onBack}>
            ← К проектам
          </Button>
          <div className={styles.titleBlock}>
            <h2 className={styles.title}>{project.name}</h2>
            <p className={styles.subtitle}>Монитор задач проекта</p>
          </div>
        </div>
        <div className={styles.headActions}>
          {lastUpdated && (
            <span className={styles.updated} aria-live="polite">
              Обновлено в {formatTime(lastUpdated)}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load(offset)}
            disabled={loadState === 'loading'}
          >
            Обновить
          </Button>
          {onEdit && (
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<Settings size={16} aria-hidden="true" />}
              onClick={() => onEdit(project)}
            >
              Настройка
            </Button>
          )}
        </div>
      </header>

      {summary && loadState !== 'error' && (
        <dl className={styles.summary}>
          <Stat label="Всего" value={summary.total} />
          <Stat label="Активных" value={summary.active} tone="primary" />
          <Stat label="Завершено" value={summary.completed} tone="success" />
          <Stat label="Заблокировано" value={summary.blocked} tone={summary.blocked ? 'danger' : 'neutral'} />
          <Stat label="Ср. время завершённых" text={formatDuration(summary.averageCompletedDurationMs)} />
        </dl>
      )}

      {data && loadState !== 'error' && (
        <div className={styles.viewToggle} role="tablist" aria-label="Вид монитора">
          <Button
            variant={view === 'roles' ? 'primary' : 'secondary'}
            size="sm"
            role="tab"
            aria-selected={view === 'roles'}
            onClick={() => setView('roles')}
          >
            По ролям
          </Button>
          <Button
            variant={view === 'tasks' ? 'primary' : 'secondary'}
            size="sm"
            role="tab"
            aria-selected={view === 'tasks'}
            onClick={() => setView('tasks')}
          >
            По задачам
          </Button>
        </div>
      )}

      {loadState === 'loading' && !data && <LoadingBlock label="Загрузка статистики задач…" />}

      {loadState === 'error' && (
        <EmptyState
          tone="error"
          title="Не удалось загрузить монитор"
          description={errorMsg}
          action={
            <Button variant="secondary" onClick={() => void load(offset)}>
              Повторить
            </Button>
          }
        />
      )}

      {/* --- Вид «По ролям»: сводка задач проекта по ответственным ролям. --- */}
      {data && loadState !== 'error' && view === 'roles' && (
        <div className={styles.tableWrap} role="region" aria-label="Таблица по ролям" tabIndex={0}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Роль</th>
                <th scope="col">Этап пайплайна</th>
                <th scope="col">Задач сейчас</th>
              </tr>
            </thead>
            <tbody>
              {roleStats.map((r) => (
                <tr key={r.name}>
                  <td className={styles.cellTitle}>
                    <Badge tone={r.count ? r.tone : 'neutral'}>{r.name}</Badge>
                  </td>
                  <td className={styles.cellMuted}>{r.stageLabel}</td>
                  <td className={styles.live}>{r.count}</td>
                </tr>
              ))}
              {queueCount > 0 && (
                <tr>
                  <td className={styles.cellMuted}>В очереди</td>
                  <td className={styles.cellMuted}>{statusLabel('BACKLOG')} · {statusLabel('READY')}</td>
                  <td className={styles.live}>{queueCount}</td>
                </tr>
              )}
            </tbody>
          </table>
          {(summary?.total ?? 0) === 0 && (
            <p className={styles.noMatch}>
              В этом проекте пока нет задач. Когда оркестратор создаст их, распределение по ролям появится здесь.
            </p>
          )}
        </div>
      )}

      {loadState === 'ready' && view === 'tasks' && rows.length === 0 && (
        <EmptyState
          icon={<Layers size={36} aria-hidden="true" />}
          title="В этом проекте пока нет задач"
          description="Когда оркестратор создаст задачи, они появятся здесь с этапами и временем выполнения."
        />
      )}

      {loadState !== 'error' && view === 'tasks' && rows.length > 0 && (
        <>
          <div className={styles.filters}>
            <Select
              label="Этап"
              value={filterStage}
              onChange={(e) => setFilterStage(e.target.value)}
            >
              <option value="">Все этапы</option>
              {stageOptions.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))}
            </Select>
            <Select
              label="Статус"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
            >
              <option value="">Все статусы</option>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {statusLabel(s)}
                </option>
              ))}
            </Select>
            <Select
              label="Сортировка"
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
            >
              <option value="default">По активности (сервер)</option>
              <option value="stage">По этапу</option>
              <option value="status">По статусу</option>
              <option value="duration">По общему времени</option>
            </Select>
          </div>

          <div className={styles.tableWrap} role="region" aria-label="Таблица задач" tabIndex={0}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Задача</th>
                  <th scope="col">Сервис</th>
                  <th scope="col">Текущий этап</th>
                  <th scope="col">Статус</th>
                  <th scope="col">Время на этапе</th>
                  <th scope="col">Общее время</th>
                  <th scope="col">Обновлено</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <TaskRow key={r.id} row={r} elapsed={elapsedSinceFetch} />
                ))}
              </tbody>
            </table>
            {visibleRows.length === 0 && (
              <p className={styles.noMatch}>Нет задач под выбранные фильтры.</p>
            )}
          </div>

          <footer className={styles.pager}>
            <span className={styles.pagerInfo}>
              {pageStart}–{pageEnd} из {total}
            </span>
            <div className={styles.pagerBtns}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
                disabled={offset === 0 || loadState === 'loading'}
              >
                Назад
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setOffset((o) => o + PAGE_SIZE)}
                disabled={offset + PAGE_SIZE >= total || loadState === 'loading'}
              >
                Вперёд
              </Button>
            </div>
          </footer>
        </>
      )}
    </section>
  );
}

function TaskRow({ row, elapsed }: { row: TaskStatRow; elapsed: number }) {
  const active = row.timingState === 'active';
  const stageMs = liveDuration(row.stageDurationMs, active, elapsed);
  const totalMs = liveDuration(row.totalDurationMs, active, elapsed);
  const updatedIso = row.completedAt ?? row.stageStartedAt ?? row.createdAt;
  return (
    <tr>
      <td className={styles.cellTitle} title={row.title}>
        {row.title}
      </td>
      <td>{row.service ?? '—'}</td>
      <td>{row.stageName}</td>
      <td>
        <Badge tone={statusTone(row.status)} pulse={active}>
          {statusLabel(row.status)}
        </Badge>
      </td>
      <td className={active ? styles.live : undefined}>{formatDuration(stageMs)}</td>
      <td className={active ? styles.live : undefined}>{formatDuration(totalMs)}</td>
      <td className={styles.cellMuted}>{updatedIso ? formatDateTime(updatedIso) : 'Нет данных'}</td>
    </tr>
  );
}

function Stat({
  label,
  value,
  text,
  tone = 'neutral',
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: BadgeTone;
}) {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={`${styles.statValue} ${styles[`tone_${tone}`] ?? ''}`}>
        {text ?? value}
      </dd>
    </div>
  );
}
