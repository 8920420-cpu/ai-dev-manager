import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Callout, LoadingBlock, PageHeader, Section } from '../../components/ui';
import {
  performanceApi,
  type PerformanceMetrics,
  type RoleLoad,
  type RoleLoadWindow,
  type RoleLoadTaskTotals,
  type RoleLoadPeriods,
  type RoleLoadTotals,
  type RoleLoadPeriod,
  type PeriodDelta,
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

// ROLE-LOAD-DEPLOY-PERIOD-001 — процент изменения показателя с 1 знаком после
// запятой в ru-формате (0.123 → «+12,3%», −0.045 → «−4,5%», 0 → «0,0%»).
function fmtPercent(pct: number): string {
  const sign = pct > 0 ? '+' : pct < 0 ? '−' : '';
  return `${sign}${(Math.abs(pct) * 100).toFixed(1).replace('.', ',')}%`;
}

// ROLE-LOAD-DEPLOY-PERIOD-001 — сравнение показателя с периодом предыдущего
// обновления: стрелка вверх/вниз по знаку изменения + процент, тем же цветом.
// improved=true → зелёный (эффективность выросла), false → красный (снизилась),
// null → серый (изменения нет). delta=null/pct=null → ничего не показываем
// (нет периода сравнения либо в нём нет прогонов — требование 4).
function PeriodDeltaTag({ delta }: { delta: PeriodDelta | null | undefined }) {
  if (!delta || delta.pct == null) return null;
  const tone = delta.improved == null ? 'neutral' : delta.improved ? 'good' : 'bad';
  const arrow = delta.pct > 0 ? '↑' : delta.pct < 0 ? '↓' : '';
  return (
    <span className={cn(styles.delta, styles[tone])}>
      {arrow}
      {fmtPercent(delta.pct)}
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

// ROLE-LOAD-LAST-DATA-001 — периоды вкладки «Суммы» блока «Нагрузка по ролям».
const ROLE_LOAD_PERIODS: { key: RoleLoadPeriod; label: string }[] = [
  { key: 'month', label: 'Месяц' },
  { key: 'week', label: 'Неделя' },
  { key: 'day', label: 'День' },
];

// Часы простоя в человекочитаемом виде (для метки устаревания блока).
function fmtHours(h: number): string {
  if (h < 24) return `${Math.round(h)} ч`;
  const d = Math.floor(h / 24);
  const rem = Math.round(h % 24);
  return rem ? `${d} дн ${rem} ч` : `${d} дн`;
}

// ROLE-LOAD-LAST-DATA-001 — подпись «последняя активность» + бейдж устаревания.
// При простое дольше окна показываем предупреждение, но данные остаются видны.
function StaleNote({ windowInfo }: { windowInfo: RoleLoadWindow }) {
  if (!windowInfo.windowEnd) return null;
  const end = new Date(windowInfo.windowEnd).toLocaleString('ru-RU');
  if (!windowInfo.stale) {
    return <span className={styles.muted}>Последняя активность: {end}.</span>;
  }
  return (
    <Callout tone="warning" title="Показаны последние имевшиеся данные">
      <span className={styles.muted}>
        Оркестратор простаивает ~{fmtHours(windowInfo.staleHours)} — свежих запусков за окно нет.
        Последняя активность: {end}.
      </span>
    </Callout>
  );
}

// ROLE-LOAD-DEPLOY-PERIOD-001 — подпись «период с последнего обновления». В режиме
// маркеров показывает начало текущего периода (последний деплой) и есть ли сравнение
// с периодом предыдущего обновления. В фолбэке (маркеров нет) ничего не выводит —
// его роль берёт на себя StaleNote.
function PeriodNote({ periods }: { periods: RoleLoadPeriods }) {
  if (periods.mode !== 'markers' || !periods.current) return null;
  const start = new Date(periods.current.start).toLocaleString('ru-RU');
  const ref = periods.marker?.ref ? ` ${periods.marker.ref}` : '';
  const hasComparison = !!periods.previous && periods.previousHasRuns;
  return (
    <span className={styles.muted}>
      Статистика считается с нуля от последнего обновления{ref} ({start}).{' '}
      {hasComparison
        ? 'Рядом с показателями — сравнение с периодом предыдущего обновления: стрелка и процент.'
        : 'Периода предыдущего обновления с прогонами нет — сравнение не показывается.'}
    </span>
  );
}

/**
 * Блок «Нагрузка по ролям» с двумя вкладками:
 *  — «Средние на задачу» (основной вид): токены/стоимость усреднены на задачу;
 *  — «Суммы (месяц/неделя/день)»: суммарные значения за период.
 * ROLE-LOAD-DEPLOY-PERIOD-001: основной вид считается с нуля от последнего деплой-
 * маркера ([последний маркер; now]); рядом с показателями — сравнение с периодом
 * предыдущего обновления (стрелка ↑/↓ и процент, цвет по направленности метрики).
 * Фолбэк без деплой-маркеров: окно 24ч от последней активности, без сравнения.
 */
function RoleLoadSection({
  roleLoad,
  window: windowInfo,
  taskTotals,
  periods,
}: {
  roleLoad: RoleLoad[];
  window: RoleLoadWindow;
  taskTotals: RoleLoadTaskTotals;
  periods: RoleLoadPeriods;
}) {
  const [tab, setTab] = useState<'avg' | 'totals'>('avg');
  // ROLE-LOAD-TASK-TOTALS-001: «Итого (полная задача)» — ИСТИННОЕ сквозное среднее
  // по задачам, посчитанное на бэкенде (roleLoadTaskTotals): сумма всех прогонов
  // всех ролей одной DONE-задачи (включая повторы/RESTART/доработки), усреднённая
  // по завершённым задачам за окно. Клиентская сумма средних по ролям УДАЛЕНА —
  // она ЗАПРЕЩЕНА методикой. Здесь фронтенд только отображает готовые значения.
  return (
    <Section
      title="Нагрузка по ролям (с последнего обновления)"
      description="Основной вид считается с нуля от последнего обновления системы (деплой-маркер): данные разных обновлений не смешиваются. Рядом с каждым показателем — сравнение с периодом предыдущего обновления: стрелка ↑/↓ и процент изменения, зелёным при росте эффективности и красным при снижении. «Токены вх/исх» и «Стоимость» — средние на задачу; суммарные значения по периодам месяц/неделя/день — на вкладке «Суммы»."
    >
      <div className={styles.tabs}>
        <button
          type="button"
          className={cn(styles.tabBtn, tab === 'avg' && styles.tabActive)}
          onClick={() => setTab('avg')}
        >
          Средние на задачу
        </button>
        <button
          type="button"
          className={cn(styles.tabBtn, tab === 'totals' && styles.tabActive)}
          onClick={() => setTab('totals')}
        >
          Суммы (месяц/неделя/день)
        </button>
      </div>

      {tab === 'avg' ? (
        <>
          {periods.mode === 'markers' ? (
            <PeriodNote periods={periods} />
          ) : (
            <StaleNote windowInfo={windowInfo} />
          )}
          {roleLoad.length === 0 ? (
            <span className={styles.muted}>
              {periods.mode === 'markers'
                ? 'С последнего обновления запусков ролей ещё не было.'
                : 'Запусков ролей ещё не было.'}
            </span>
          ) : (
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead>
                <tr>
                  <th>Роль</th>
                  <th className={styles.num}>Запуски</th>
                  <th className={styles.num}>Задачи</th>
                  <th className={styles.num}>Успех</th>
                  <th className={styles.num} title="Настоящие провалы агента: FAILED-прогоны, где агент реально не справился (упор в лимит ходов, agent_reported_failure, verdict_unparsed и т.п.)">Провал</th>
                  <th className={styles.num} title="Возвраты захвата в пул без результата (напр. outcome='released'), а не провалы кода: прогон освобождён из-за петли захват→release, таймаута назначения или рестарта оркестратора">Возвраты</th>
                  <th className={styles.num}>Таймаут</th>
                  <th className={styles.num}>В работе</th>
                  <th className={styles.num}>Ср. время</th>
                  <th className={styles.num}>Токены вх / зад.</th>
                  <th className={styles.num}>Токены исх / зад.</th>
                  <th className={styles.num}>Стоимость / зад.</th>
                  <th className={styles.num}>Ср. холодн. старт</th>
                </tr>
              </thead>
              <tbody>
                {roleLoad.map((r) => {
                  const perTask = (v: number) => (r.tasks > 0 ? Math.round(v / r.tasks) : 0);
                  return (
                    <tr key={r.roleCode}>
                      <td>{r.roleName ?? r.roleCode}</td>
                      <td className={styles.num}>{r.runs}</td>
                      <td className={styles.num}>{r.tasks}</td>
                      <td className={styles.num}>
                        {r.success}
                        <PeriodDeltaTag delta={r.delta?.success} />
                      </td>
                      <td className={styles.num}>
                        {r.failed}
                        <PeriodDeltaTag delta={r.delta?.failed} />
                      </td>
                      <td
                        className={styles.num}
                        title="Возвраты захвата в пул без результата (не провалы кода): прогон освобождён при петле захват→release, таймауте назначения или рестарте оркестратора"
                      >
                        {r.returns}
                      </td>
                      <td className={styles.num}>
                        {r.timeout}
                        <PeriodDeltaTag delta={r.delta?.timeout} />
                      </td>
                      <td className={styles.num}>{r.running}</td>
                      <td className={styles.num}>
                        {fmtDuration(r.avgDurationMs)}
                        <PeriodDeltaTag delta={r.delta?.avgDurationMs} />
                      </td>
                      <td className={styles.num}>
                        {r.avgTokensInPerTask == null ? '—' : fmtTokens(r.avgTokensInPerTask)}
                        <PeriodDeltaTag delta={r.delta?.avgTokensInPerTask} />
                        {r.tokensIn > 0 && r.tasks > 0 && (
                          <span
                            className={styles.tokenSplit}
                            title={`на задачу: свежий ${perTask(r.tokensInputFresh)} · запись в кэш ${perTask(r.tokensCacheCreation)} · чтение из кэша ${perTask(r.tokensCacheRead)}`}
                          >
                            свеж {fmtTokens(perTask(r.tokensInputFresh))} · зап {fmtTokens(perTask(r.tokensCacheCreation))} · чт {fmtTokens(perTask(r.tokensCacheRead))}
                          </span>
                        )}
                      </td>
                      <td className={styles.num}>
                        {r.avgTokensOutPerTask == null ? '—' : fmtTokens(r.avgTokensOutPerTask)}
                        <PeriodDeltaTag delta={r.delta?.avgTokensOutPerTask} />
                      </td>
                      <td className={styles.num}>
                        {r.avgCostPerTask == null ? '—' : fmtCost(r.avgCostPerTask)}
                        <PeriodDeltaTag delta={r.delta?.avgCostPerTask} />
                      </td>
                      <td className={styles.num}>
                        {fmtDuration(r.avgColdStartMs)}
                        <PeriodDeltaTag delta={r.delta?.avgColdStartMs} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className={styles.totalRow}>
                  <td title="Истинное сквозное среднее по DONE-задачам за окно: суммарные затраты всех прогонов всех ролей одной задачи (включая повторы, RESTART и доработки), усреднённые по завершённым задачам">
                    Итого (полная задача)
                  </td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num} title="Число завершённых (DONE) задач в окне — знаменатель средних">
                    {taskTotals.tasks || '—'}
                  </td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>—</td>
                  <td className={styles.num}>
                    {fmtDuration(taskTotals.avgWorkMs)}
                    <PeriodDeltaTag delta={taskTotals.delta?.avgWorkMs} />
                    {taskTotals.avgLeadMs != null && (
                      <span
                        className={styles.tokenSplit}
                        title="Среднее сквозное календарное время: создание задачи → DONE"
                      >
                        календарно {fmtDuration(taskTotals.avgLeadMs)}
                        <PeriodDeltaTag delta={taskTotals.delta?.avgLeadMs} />
                      </span>
                    )}
                  </td>
                  <td className={styles.num}>
                    {taskTotals.avgTokensIn == null ? '—' : fmtTokens(taskTotals.avgTokensIn)}
                    <PeriodDeltaTag delta={taskTotals.delta?.avgTokensIn} />
                  </td>
                  <td className={styles.num}>
                    {taskTotals.avgTokensOut == null ? '—' : fmtTokens(taskTotals.avgTokensOut)}
                    <PeriodDeltaTag delta={taskTotals.delta?.avgTokensOut} />
                  </td>
                  <td className={styles.num}>
                    {taskTotals.avgCost == null ? '—' : fmtCost(taskTotals.avgCost)}
                    <PeriodDeltaTag delta={taskTotals.delta?.avgCost} />
                  </td>
                  <td className={styles.num}>—</td>
                </tr>
              </tfoot>
            </table></div>
          )}
        </>
      ) : (
        <RoleLoadTotalsTab />
      )}
    </Section>
  );
}

/**
 * Вкладка «Суммы» блока «Нагрузка по ролям»: суммарные значения по ролям за
 * выбранный период (месяц/неделя/день). Отдельный запрос к /role-load-totals.
 */
function RoleLoadTotalsTab() {
  const [period, setPeriod] = useState<RoleLoadPeriod>('month');
  const [data, setData] = useState<RoleLoadTotals | null>(null);
  const [state, setState] = useState<LoadState>('loading');

  // ROLE-LOAD-TOTALS-FOOTER: «Итого» за период — суммарные затраты по всем ролям.
  // Столбец «Задачи» не суммируем: мультиролевые задачи задвоились бы по этапам,
  // поэтому в подвале для него «—». Остальные поля — корректные суммы за окно.
  const totals = useMemo(() => {
    const rows = data?.roles ?? [];
    return {
      runs: rows.reduce((s, r) => s + r.runs, 0),
      success: rows.reduce((s, r) => s + r.success, 0),
      failed: rows.reduce((s, r) => s + r.failed, 0),
      returns: rows.reduce((s, r) => s + r.returns, 0),
      timeout: rows.reduce((s, r) => s + r.timeout, 0),
      tokensIn: rows.reduce((s, r) => s + r.tokensIn, 0),
      tokensOut: rows.reduce((s, r) => s + r.tokensOut, 0),
      cost: rows.reduce((s, r) => s + r.cost, 0),
    };
  }, [data]);

  useEffect(() => {
    const ctrl = new AbortController();
    setState('loading');
    performanceApi
      .roleLoadTotals(period, ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setData(d);
        setState('ready');
      })
      .catch((e) => {
        if (ctrl.signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return;
        setState('error');
      });
    return () => ctrl.abort();
  }, [period]);

  return (
    <>
      <div className={styles.tabs}>
        {ROLE_LOAD_PERIODS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={cn(styles.tabBtn, period === p.key && styles.tabActive)}
            onClick={() => setPeriod(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>

      {state === 'loading' && <LoadingBlock label="Загрузка сумм…" />}
      {state === 'error' && <Callout tone="error" title="Не удалось загрузить суммарные значения" />}
      {state === 'ready' && data && (
        <>
          <StaleNote windowInfo={data} />
          {data.roles.length === 0 ? (
            <span className={styles.muted}>За выбранный период запусков ролей нет.</span>
          ) : (
            <div className={styles.tableScroll}><table className={styles.table}>
              <thead>
                <tr>
                  <th>Роль</th>
                  <th className={styles.num}>Запуски</th>
                  <th className={styles.num}>Задачи</th>
                  <th className={styles.num}>Успех</th>
                  <th className={styles.num} title="Настоящие провалы агента (FAILED, где агент реально не справился)">Провал</th>
                  <th className={styles.num} title="Возвраты захвата в пул без результата (напр. outcome='released'), а не провалы кода">Возвраты</th>
                  <th className={styles.num}>Таймаут</th>
                  <th className={styles.num}>Токены вх (сумма)</th>
                  <th className={styles.num}>Токены исх (сумма)</th>
                  <th className={styles.num}>Стоимость (сумма)</th>
                </tr>
              </thead>
              <tbody>
                {data.roles.map((r) => (
                  <tr key={r.roleCode}>
                    <td>{r.roleName ?? r.roleCode}</td>
                    <td className={styles.num}>{r.runs}</td>
                    <td className={styles.num}>{r.tasks}</td>
                    <td className={styles.num}>{r.success}</td>
                    <td className={styles.num}>{r.failed}</td>
                    <td className={styles.num}>{r.returns}</td>
                    <td className={styles.num}>{r.timeout}</td>
                    <td className={styles.num}>{fmtTokens(r.tokensIn)}</td>
                    <td className={styles.num}>{fmtTokens(r.tokensOut)}</td>
                    <td className={styles.num}>{fmtCost(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className={styles.totalRow}>
                  <td>Итого</td>
                  <td className={styles.num}>{totals.runs}</td>
                  <td className={styles.num} title="Задачи мультиролевые — уникальные задачи по ролям суммировать нельзя">
                    —
                  </td>
                  <td className={styles.num}>{totals.success}</td>
                  <td className={styles.num}>{totals.failed}</td>
                  <td className={styles.num}>{totals.returns}</td>
                  <td className={styles.num}>{totals.timeout}</td>
                  <td className={styles.num}>{fmtTokens(totals.tokensIn)}</td>
                  <td className={styles.num}>{fmtTokens(totals.tokensOut)}</td>
                  <td className={styles.num}>{fmtCost(totals.cost)}</td>
                </tr>
              </tfoot>
            </table></div>
          )}
        </>
      )}
    </>
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
            <div className={styles.tableScroll}><table className={styles.table}>
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
            </table></div>
          ) : (
            <div className={styles.tableScroll}><table className={styles.table}>
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
            </table></div>
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
          <RoleLoadSection
            roleLoad={data.roleLoad}
            window={data.roleLoadWindow}
            taskTotals={data.roleLoadTaskTotals}
            periods={data.roleLoadPeriods}
          />

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

          <VersionsSection roleCodes={data.roleLoad.map((r) => ({ code: r.roleCode, name: r.roleName }))} />

          <Section
            title="Ёмкость LLM-коннектора"
            description="Адаптивный лимитер вызовов: текущий лимит параллельных вызовов, активные и токены в минуту по провайдерам."
          >
            {Object.keys(data.connector).length === 0 ? (
              <span className={styles.muted}>Коннектор ещё не использовался — данных нет.</span>
            ) : (
              <div className={styles.tableScroll}><table className={styles.table}>
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
              </table></div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
