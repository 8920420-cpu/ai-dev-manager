import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Callout, LoadingBlock, PageHeader, Section } from '../../components/ui';
import {
  performanceApi,
  type PerformanceMetrics,
  type VersionMetrics,
  type VersionRow,
  type VersionDelta,
} from '../../api/performanceApi';
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

// OBSERVABILITY-REASONING-001: компактный формат числа токенов (1.2k / 3.4M).
function fmtTokens(n: number): string {
  if (!n) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
  if (!usd) return '—';
  return `$${usd < 1 ? usd.toFixed(3) : usd.toFixed(2)}`;
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

// VERSION-KPI-TRACKING-001 — дельта показателя версии: цвет по направлению
// «лучше/хуже». lowerIsBetter=true → рост значения = ухудшение (красный).
function DeltaTag({
  delta,
  lowerIsBetter,
  fmt,
  enoughData,
}: {
  delta: VersionDelta | null | undefined;
  lowerIsBetter: boolean;
  fmt: (n: number) => string;
  enoughData: boolean;
}) {
  if (!delta || delta.abs === 0) return null;
  const worse = lowerIsBetter ? delta.abs > 0 : delta.abs < 0;
  const tone = !enoughData ? 'neutral' : worse ? 'bad' : 'good';
  const sign = delta.abs > 0 ? '+' : '−';
  const pct = delta.pct == null ? '' : ` (${delta.abs > 0 ? '+' : '−'}${Math.abs(Math.round(delta.pct * 100))}%)`;
  return (
    <span className={cn(styles.delta, styles[tone])} title={enoughData ? '' : 'Мало данных для значимой дельты'}>
      {sign}
      {fmt(Math.abs(delta.abs))}
      {pct}
    </span>
  );
}

const VERSION_WINDOWS = [
  { label: '24 часа', hours: 24 },
  { label: '7 дней', hours: 168 },
  { label: '30 дней', hours: 720 },
];

// Подпись версии: промт vN [метка] + короткий git-SHA + модель.
function versionTitle(v: VersionRow) {
  return (
    <span className={styles.versionTag}>
      <span>
        {v.promptVersion != null ? `промт v${v.promptVersion}` : 'промт —'}
        {v.promptLabel ? ` · ${v.promptLabel}` : ''}
        {v.regression && <span className={styles.regBadge}>регресс</span>}
      </span>
      <small>
        {v.codeVersion ?? 'код —'} · {v.model ?? 'модель —'}
      </small>
    </span>
  );
}

/**
 * Раздел «Версии и влияние изменений»: KPI выбранной роли по версиям (промт/код/
 * модель) с дельтой к предыдущей версии. Отвечает на «поправили промт/код — как
 * сместились показатели». Регресс (рост времени/токенов сверх порога при достаточной
 * выборке) подсвечивается. Источник: agent_runs (рассуждающие роли) либо task_events
 * (программист). Метки (правка промта/деплой) — вертикальные отметки на оси времени.
 */
function VersionsSection({ roleCodes }: { roleCodes: { code: string; name: string }[] }) {
  const roles = useMemo(() => {
    const list = [...roleCodes];
    // Программист в roleLoad не появляется (его KPI в task_events) — добавим явно.
    if (!list.some((r) => r.code === 'PROGRAMMER')) list.push({ code: 'PROGRAMMER', name: 'Программист' });
    return list;
  }, [roleCodes]);

  const [role, setRole] = useState<string>(roles[0]?.code ?? '');
  const [hours, setHours] = useState<number>(168);
  const [modelFilter, setModelFilter] = useState<string>('');
  const [data, setData] = useState<VersionMetrics | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  useEffect(() => {
    if (!role) return;
    const ctrl = new AbortController();
    setState('loading');
    performanceApi
      .versions(role, { windowHours: hours }, ctrl.signal)
      .then((v) => {
        if (ctrl.signal.aborted) return;
        setData(v);
        setModelFilter('');
        setState('ready');
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setState('error');
      });
    return () => ctrl.abort();
  }, [role, hours]);

  const isProgrammer = data?.source === 'task_events';
  const models = useMemo(() => {
    const set = new Set<string>();
    data?.versions.forEach((v) => v.model && set.add(v.model));
    return [...set];
  }, [data]);
  const versions = useMemo(
    () => (data?.versions ?? []).filter((v) => !modelFilter || v.model === modelFilter),
    [data, modelFilter],
  );
  const regressed = versions.filter((v) => v.regression);

  return (
    <Section
      title="Версии и влияние изменений"
      description="KPI роли по версиям промта/кода/модели с дельтой к предыдущей версии. Видно, как правка промта или кода сместила время, токены и проходы. Регресс (рост сверх 10% при выборке ≥5) подсвечен. Серая дельта — данных мало, значению доверять рано."
    >
      <div className={styles.versionControls}>
        <label>
          Роль
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {roles.map((r) => (
              <option key={r.code} value={r.code}>
                {r.name ?? r.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Окно
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))}>
            {VERSION_WINDOWS.map((w) => (
              <option key={w.hours} value={w.hours}>
                {w.label}
              </option>
            ))}
          </select>
        </label>
        {models.length > 1 && (
          <label>
            Модель
            <select value={modelFilter} onChange={(e) => setModelFilter(e.target.value)}>
              <option value="">все</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {state === 'loading' && <LoadingBlock label="Загрузка версий…" />}
      {state === 'error' && (
        <Callout tone="error" title="Не удалось загрузить версии роли" />
      )}

      {state === 'ready' && data && (
        <>
          {regressed.length > 0 && (
            <Callout tone="warning" title={`Регресс в ${regressed.length} версии(ях)`}>
              <span className={styles.muted}>
                У свежих версий показатели ухудшились против предыдущей сверх порога:{' '}
                {regressed
                  .map((v) => `${v.promptVersion != null ? `v${v.promptVersion}` : v.codeVersion} (${v.regressedMetrics.join(', ')})`)
                  .join('; ')}
                .
              </span>
            </Callout>
          )}

          {versions.length === 0 ? (
            <span className={styles.muted}>За выбранное окно прогонов с метками версии нет.</span>
          ) : isProgrammer ? (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Версия</th>
                  <th className={styles.num}>Сдач</th>
                  <th className={styles.num}>Ср. проходов</th>
                  <th className={styles.num}>Макс. проходов</th>
                  <th className={styles.num}>Упоров в лимит</th>
                  <th className={styles.num}>Период</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <tr key={i} className={cn(v.regression && styles.regressionRow)}>
                    <td>{versionTitle(v)}</td>
                    <td className={styles.num}>{v.n}</td>
                    <td className={styles.num}>
                      {v.avgPasses ?? '—'}
                      <DeltaTag delta={v.delta.avgPasses} lowerIsBetter fmt={(n) => n.toFixed(1)} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>{v.maxPasses ?? '—'}</td>
                    <td className={styles.num} title="задачи, не влезшие в бюджет ходов">
                      {v.limitHits ?? 0}
                    </td>
                    <td className={styles.num}>{fmtRange(v.firstRun, v.lastRun)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Версия</th>
                  <th className={styles.num}>Прогонов</th>
                  <th className={styles.num}>Успех</th>
                  <th className={styles.num}>Ср. время</th>
                  <th className={styles.num}>Cold start</th>
                  <th className={styles.num}>Токены вх</th>
                  <th className={styles.num}>Токены исх</th>
                  <th className={styles.num}>Стоимость</th>
                  <th className={styles.num}>Ходов</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v, i) => (
                  <tr key={i} className={cn(v.regression && styles.regressionRow)}>
                    <td>{versionTitle(v)}</td>
                    <td className={styles.num}>{v.n}</td>
                    <td className={styles.num}>
                      {v.successRate == null ? '—' : `${Math.round(v.successRate * 100)}%`}
                      <DeltaTag delta={v.delta.successRate} lowerIsBetter={false} fmt={(n) => `${Math.round(n * 100)}%`} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {fmtDuration(v.avgDurationMs)}
                      <DeltaTag delta={v.delta.avgDurationMs} lowerIsBetter fmt={(n) => fmtDuration(n)} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {fmtDuration(v.avgColdStartMs)}
                      <DeltaTag delta={v.delta.avgColdStartMs} lowerIsBetter fmt={(n) => fmtDuration(n)} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {fmtTokens(v.avgTokensIn ?? 0)}
                      <DeltaTag delta={v.delta.avgTokensIn} lowerIsBetter fmt={(n) => fmtTokens(Math.round(n))} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {fmtTokens(v.avgTokensOut ?? 0)}
                      <DeltaTag delta={v.delta.avgTokensOut} lowerIsBetter fmt={(n) => fmtTokens(Math.round(n))} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {fmtCost(v.avgCost ?? 0)}
                      <DeltaTag delta={v.delta.avgCost} lowerIsBetter fmt={(n) => fmtCost(n)} enoughData={v.enoughData} />
                    </td>
                    <td className={styles.num}>
                      {v.avgTurns ?? '—'}
                      <DeltaTag delta={v.delta.avgTurns} lowerIsBetter fmt={(n) => n.toFixed(1)} enoughData={v.enoughData} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {data.markers.length > 0 && (
            <div className={styles.statusRow} style={{ marginTop: 'var(--space-3)' }}>
              {data.markers.slice(0, 12).map((m) => (
                <span key={m.id} className={styles.statusChip} title={new Date(m.createdAt).toLocaleString('ru-RU')}>
                  {m.type === 'prompt_version' ? '✎' : m.type === 'deploy' ? '🚀' : '•'}{' '}
                  {m.description ?? m.ref ?? m.type}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

function fmtRange(a: string | null, b: string | null): string {
  if (!a) return '—';
  const fa = new Date(a).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  if (!b) return fa;
  const fb = new Date(b).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  return fa === fb ? fa : `${fa}–${fb}`;
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
            description="Запуски, доля провалов, средняя длительность, токены и средний холодный старт движка. «Токены вх» разложены: свеж — свежий (uncached) ввод; зап — запись в prompt-кэш; чт — чтение из кэша (копится по ходам tool-loop, обычно доминирует, billed ~10%)."
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
                    <th className={styles.num}>Токены вх</th>
                    <th className={styles.num}>Токены исх</th>
                    <th className={styles.num}>Стоимость</th>
                    <th className={styles.num}>Ср. холодн. старт</th>
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
                      <td className={styles.num}>
                        {fmtTokens(r.tokensIn)}
                        {r.tokensIn > 0 && (
                          <span
                            className={styles.tokenSplit}
                            title={`свежий ${r.tokensInputFresh} · запись в кэш ${r.tokensCacheCreation} · чтение из кэша ${r.tokensCacheRead}`}
                          >
                            свеж {fmtTokens(r.tokensInputFresh)} · зап {fmtTokens(r.tokensCacheCreation)} · чт {fmtTokens(r.tokensCacheRead)}
                          </span>
                        )}
                      </td>
                      <td className={styles.num}>{fmtTokens(r.tokensOut)}</td>
                      <td className={styles.num}>{fmtCost(r.cost)}</td>
                      <td className={styles.num}>{fmtDuration(r.avgColdStartMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <VersionsSection roleCodes={data.roleLoad.map((r) => ({ code: r.roleCode, name: r.roleName }))} />

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
