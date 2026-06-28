import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Callout, LoadingBlock, PageHeader, Section } from '../../components/ui';
import { performanceApi, type PerformanceMetrics } from '../../api/performanceApi';
import { cn } from '../../lib/cn';
import styles from './monitor.module.css';

type LoadState = 'loading' | 'error' | 'ready';

const STATUS_LABEL: Record<string, string> = {
  BACKLOG: 'Бэклог',
  READY: 'Готова',
  ARCHITECTURE: 'Архитектура',
  DECOMPOSITION: 'Декомпозиция',
  CODING: 'Разработка',
  TESTING: 'Тесты',
  FAILURE_ANALYSIS: 'Анализ сбоя',
  REVIEW: 'Ревью',
  COMMIT: 'Коммит',
  DEPLOY: 'Деплой',
  DONE: 'Завершено',
  BLOCKED: 'Заблокировано',
  FAILED: 'Ошибка',
  CANCELLED: 'Отменено',
  WAITING_FOR_CHILDREN: 'Ждёт подзадачи',
  RESTART: 'Перезапуск',
};

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  return `${h} ч ${m % 60} мин`;
}

function Metric({
  value,
  label,
  hint,
  tone,
}: {
  value: string | number;
  label: string;
  hint?: string;
  tone?: 'warn' | 'danger';
}) {
  return (
    <div className={styles.metric}>
      <span className={cn(styles.metricValue, tone && styles[tone])}>{value}</span>
      <span className={styles.metricLabel}>{label}</span>
      {hint && <span className={styles.metricHint}>{hint}</span>}
    </div>
  );
}

/**
 * Раздел «Монитор производительности» — НЕ-AI наблюдаемость оркестратора.
 * Все цифры считаются на сервере из tasks/task_events/agent_runs и телеметрии
 * адаптивного лимитера (GET /api/performance). Модель не задействована.
 * Автообновление раз в 15 секунд; ручное обновление — кнопкой.
 */
export function PerformanceMonitorPage() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [data, setData] = useState<PerformanceMetrics | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoadState('loading');
    try {
      const m = await performanceApi.get(undefined, signal);
      if (signal?.aborted) return;
      setData(m);
      setLoadState('ready');
    } catch (e) {
      if (signal?.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void load(ctrl.signal);
    timer.current = window.setInterval(() => void load(undefined, true), 15000);
    return () => {
      ctrl.abort();
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  return (
    <div className={styles.page}>
      <PageHeader
        title="Монитор производительности"
        description="Метрики и KPI оркестратора без участия модели: пропускная способность, очередь, повторная работа, нагрузка по ролям и ёмкость LLM-коннектора. Считается на сервере из задач, событий и запусков. Обновляется автоматически каждые 15 с."
      />

      <div className={styles.toolbar}>
        <span className={styles.generatedAt}>
          {data ? `Срез: ${new Date(data.generatedAt).toLocaleString('ru-RU')}` : ''}
        </span>
        <Button variant="secondary" onClick={() => void load()}>
          Обновить
        </Button>
      </div>

      {loadState === 'loading' && <LoadingBlock label="Загрузка метрик…" />}

      {loadState === 'error' && (
        <Callout tone="error" title="Не удалось загрузить метрики">
          <Button variant="secondary" onClick={() => void load()}>
            Повторить
          </Button>
        </Callout>
      )}

      {loadState === 'ready' && data && (
        <>
          <Section
            title="Пропускная способность и очередь"
            description="Сколько задач закрывается и сколько ждёт исполнителя прямо сейчас."
          >
            <div className={styles.metricGrid}>
              <Metric
                value={data.throughput.completedLastHour}
                label="Закрыто за час"
                hint="DONE + CANCELLED за 60 минут"
              />
              <Metric
                value={data.throughput.completedLast24h}
                label="Закрыто за сутки"
                hint="DONE + CANCELLED за 24 часа"
              />
              <Metric
                value={data.throughput.createdLast24h}
                label="Создано за сутки"
                hint="новых задач за 24 часа"
              />
              <Metric value={data.tasks.active} label="Активных задач" hint="не закрыты и не заблокированы" />
              <Metric
                value={data.queue.backlog}
                label="В бэклоге"
                tone={data.queue.backlog > 0 ? 'warn' : undefined}
              />
              <Metric
                value={data.queue.codingUnclaimed}
                label="CODING без исполнителя"
                hint="ждут programmer-runner"
                tone={data.queue.codingUnclaimed > 0 ? 'warn' : undefined}
              />
              <Metric value={data.queue.review} label="На ревью" />
              <Metric
                value={data.queue.restart}
                label="В RESTART"
                tone={data.queue.restart > 0 ? 'danger' : undefined}
              />
            </div>
          </Section>

          <Section
            title="Качество и повторная работа"
            description="Доля повторных проходов по этапам — индикатор переделок и зацикливаний."
          >
            <div className={styles.metricGrid}>
              <Metric
                value={`${Math.round(data.rework.retryRate * 100)}%`}
                label="Retry rate"
                hint="лишние повторные входы в этап / все переходы"
                tone={data.rework.retryRate >= 0.3 ? 'danger' : data.rework.retryRate >= 0.15 ? 'warn' : undefined}
              />
              <Metric value={data.rework.reworkExtra} label="Повторных проходов" hint="суммарно лишних входов в этапы" />
              <Metric value={data.rework.transitions} label="Всего переходов" />
              <Metric
                value={data.tasks.failed}
                label="Ошибок (FAILED)"
                tone={data.tasks.failed > 0 ? 'danger' : undefined}
              />
              <Metric
                value={data.tasks.blocked}
                label="Заблокировано"
                tone={data.tasks.blocked > 0 ? 'warn' : undefined}
              />
              <Metric value={data.tasks.completed} label="Завершено всего" />
              <Metric value={fmtDuration(data.timings.averageCompletedDurationMs)} label="Среднее время задачи" hint="от создания до DONE" />
              <Metric value={data.tasks.total} label="Задач всего" />
            </div>
          </Section>

          <Section
            title="Программист: проходы и лимит ходов"
            description="За сколько проходов (ходов агента) программист закрывает задачу и как часто упирается в лимит ходов. Частые упоры — сигнал плохой нарезки задач Декомпозитором/Архитектором. Окно — 24 часа."
          >
            <div className={styles.metricGrid}>
              <Metric
                value={data.programmer.avgPasses ?? '—'}
                label="Среднее число проходов"
                hint="ходов агента до сдачи задачи"
              />
              <Metric
                value={data.programmer.maxPasses ?? '—'}
                label="Максимум проходов"
                hint="самая «тяжёлая» задача за сутки"
              />
              <Metric
                value={data.programmer.completions}
                label="Сдач за сутки"
                hint="завершений с учётом проходов"
              />
              <Metric
                value={data.programmer.limitHits}
                label="Упоров в лимит ходов"
                hint="задача не влезла в бюджет ходов"
                tone={data.programmer.limitHits > 0 ? 'danger' : undefined}
              />
            </div>
          </Section>

          <Section title="Задачи по этапам" description="Текущее распределение всех задач по статусам.">
            <div className={styles.statusRow}>
              {Object.entries(data.tasks.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, n]) => (
                  <span key={status} className={styles.statusChip}>
                    {STATUS_LABEL[status] ?? status}: <b>{n}</b>
                  </span>
                ))}
              {Object.keys(data.tasks.byStatus).length === 0 && (
                <span className={styles.muted}>Задач пока нет.</span>
              )}
            </div>
          </Section>

          <Section
            title="Нагрузка по ролям (24 часа)"
            description="Сколько запусков прошла каждая роль, доля провалов и средняя длительность."
          >
            {data.roleLoad.length === 0 ? (
              <span className={styles.muted}>За последние сутки запусков ролей не было.</span>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Роль</th>
                    <th className={styles.num}>Запуски</th>
                    <th className={styles.num}>Успех</th>
                    <th className={styles.num}>Провал</th>
                    <th className={styles.num}>Таймаут</th>
                    <th className={styles.num}>В работе</th>
                    <th className={styles.num}>Ср. время</th>
                  </tr>
                </thead>
                <tbody>
                  {data.roleLoad.map((r) => (
                    <tr key={r.roleCode}>
                      <td>{r.roleName ?? r.roleCode}</td>
                      <td className={styles.num}>{r.runs}</td>
                      <td className={styles.num}>{r.success}</td>
                      <td className={styles.num}>{r.failed}</td>
                      <td className={styles.num}>{r.timeout}</td>
                      <td className={styles.num}>{r.running}</td>
                      <td className={styles.num}>{fmtDuration(r.avgDurationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section
            title="Ёмкость LLM-коннектора"
            description="Адаптивный лимитер вызовов: текущий лимит параллельных вызовов, активные и токены в минуту по провайдерам."
          >
            {Object.keys(data.connector).length === 0 ? (
              <span className={styles.muted}>Коннектор ещё не использовался — данных нет.</span>
            ) : (
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Провайдер</th>
                    <th className={styles.num}>Лимит</th>
                    <th className={styles.num}>Активно</th>
                    <th className={styles.num}>Свободно</th>
                    <th className={styles.num}>Очередь</th>
                    <th className={styles.num}>TPM</th>
                    <th>Принимает</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.values(data.connector).map((b) => (
                    <tr key={b.key}>
                      <td>{b.key}</td>
                      <td className={styles.num}>{b.limit}</td>
                      <td className={styles.num}>{b.active}</td>
                      <td className={styles.num}>{b.free}</td>
                      <td className={styles.num}>{b.queued}</td>
                      <td className={styles.num}>{b.tpm}</td>
                      <td>{b.canSend ? 'да' : 'нет'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
