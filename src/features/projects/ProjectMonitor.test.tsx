import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';

// --- Моки сетевых клиентов компонента -------------------------------------
//
// ProjectMonitor сначала привязывает проект по папке через dbProjectsApi.register
// (получает UUID), затем тянет статистику задач taskStatisticsApi.get(apiId, …).
// Мокаем оба клиента, чтобы тесты были детерминированы и не ходили в сеть.

const registerMock = vi.fn();
vi.mock('../../api/dbProjectsApi', () => ({
  dbProjectsApi: {
    register: (input: { name: string; path: string }) => registerMock(input),
  },
}));

const getStatsMock = vi.fn();
vi.mock('../../api/taskStatisticsApi', () => ({
  taskStatisticsApi: {
    get: (projectId: string, params: unknown) => getStatsMock(projectId, params),
  },
}));

// ApiError нужен компоненту для веток обработки ошибок (status 404 и т.п.).
// Берём реальный класс — он не делает сетевых вызовов.
import { ApiError } from '../../api/http';
import { ProjectMonitor } from './ProjectMonitor';
import type { Project } from '../../types/project';
import type { TaskStatistics, TaskStatRow } from '../../types/taskStats';

// --- Тестовые данные -------------------------------------------------------

const PROJECT: Project = {
  id: 'proj_local_1',
  name: 'Проект Альфа',
  path: '/repos/alpha',
  status: 'active',
  pauseReason: null,
  stages: [],
  roles: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const DB_PROJECT = {
  id: 'uuid-alpha-0001',
  code: 'ALPHA',
  name: 'Проект Альфа',
  rootPath: '/repos/alpha',
};

// Серверная отметка времени, относительно которой растут активные длительности.
const GENERATED_AT = '2026-06-22T12:00:00.000Z';

function makeRow(over: Partial<TaskStatRow> = {}): TaskStatRow {
  return {
    id: 'task-1',
    title: 'Задача один',
    service: 'orchestrator',
    status: 'CODING',
    stageCode: 'CODING',
    stageName: 'Разработка',
    createdAt: '2026-06-22T11:00:00.000Z',
    stageStartedAt: '2026-06-22T11:50:00.000Z',
    completedAt: null,
    stageDurationMs: 60_000, // 1 мин на этапе
    totalDurationMs: 3_600_000, // 1 час всего
    timingState: 'active',
    blockReason: null,
    kpi: {
      tokenInput: 12_000,
      tokenOutput: 3_000,
      tokenCacheRead: 8_000,
      tokenCacheCreation: 1_000,
      tokenFreshInput: 3_000,
      cost: 0.42,
      turns: 12,
      runs: 3,
      failedRuns: 0,
    },
    docForcedAdvance: false,
    ...over,
  };
}

function makeStats(over: Partial<TaskStatistics> = {}): TaskStatistics {
  const tasks = over.tasks ?? [
    makeRow(),
    makeRow({
      id: 'task-2',
      title: 'Задача два',
      service: null,
      status: 'DONE',
      stageCode: 'DEPLOY',
      stageName: 'Деплой',
      completedAt: '2026-06-22T11:30:00.000Z',
      stageDurationMs: 5_000,
      totalDurationMs: 1_800_000,
      timingState: 'completed',
    }),
  ];
  return {
    projectId: DB_PROJECT.id,
    generatedAt: GENERATED_AT,
    summary: {
      total: 42,
      active: 7,
      completed: 30,
      blocked: 2,
      byStage: { CODING: 3, TESTING: 2, REVIEW: 1, DEPLOY: 1, BACKLOG: 4, READY: 1 },
      averageCompletedDurationMs: 1_200_000,
    },
    pagination: { limit: 20, offset: 0, total: 42 },
    tasks,
    ...over,
  };
}

function renderMonitor(onBack = vi.fn()) {
  return render(<ProjectMonitor project={PROJECT} onBack={onBack} />);
}

// По умолчанию работаем на реальных таймерах: тогда waitFor/findBy/userEvent
// работают штатно (внутренние задержки testing-library не зависают). Фейковые
// таймеры включаются точечно только там, где проверяется логика по времени
// (автообновление и рост live-длительностей) — см. соответствующие describe.
function setupUser() {
  return userEvent.setup();
}

beforeEach(() => {
  registerMock.mockReset();
  getStatsMock.mockReset();
  registerMock.mockResolvedValue(DB_PROJECT);
  getStatsMock.mockResolvedValue(makeStats());
});

afterEach(() => {
  cleanup();
});

// Переключиться на вкладку «По задачам» (по умолчанию открыт вид «По ролям»).
async function switchToTasks(user: ReturnType<typeof setupUser>) {
  await user.click(await screen.findByRole('tab', { name: 'По задачам' }));
}

describe('ProjectMonitor — загрузка и базовое отображение', () => {
  it('показывает индикатор загрузки, затем сводку и таблицу задач после успешного ответа', async () => {
    const user = setupUser();
    renderMonitor();

    // Пока идёт register + get — виден блок загрузки.
    expect(screen.getByText('Загрузка статистики задач…')).toBeInTheDocument();

    // Дожидаемся привязки и запроса статистики.
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    // get вызван с UUID из register и постраничными параметрами.
    expect(getStatsMock).toHaveBeenCalledWith(
      DB_PROJECT.id,
      expect.objectContaining({ limit: 20, offset: 0 }),
    );

    // Сводка-агрегаты.
    const summaryDt = await screen.findByText('Всего');
    const summary = summaryDt.closest('dl') as HTMLElement;
    expect(summary).toBeTruthy();
    expect(within(summary).getByText('42')).toBeInTheDocument(); // Всего
    expect(within(summary).getByText('7')).toBeInTheDocument(); // Активных
    expect(within(summary).getByText('30')).toBeInTheDocument(); // Завершено

    // Переходим к таблице задач.
    await switchToTasks(user);

    // Строки задач: заголовки, текущий этап, статус.
    expect(screen.getByText('Задача один')).toBeInTheDocument();
    expect(screen.getByText('Задача два')).toBeInTheDocument();
    // Текущий этап (stageName) и статус в строке первой задачи (CODING).
    const row1 = screen.getByText('Задача один').closest('tr') as HTMLElement;
    // «Разработка» встречается как stageName и как label статуса CODING.
    expect(within(row1).getAllByText('Разработка').length).toBeGreaterThanOrEqual(1);
    // Статус завершённой задачи (DONE) — внутри её строки (вне сводки, где
    // тоже есть подпись «Завершено»).
    const row2 = screen.getByText('Задача два').closest('tr') as HTMLElement;
    expect(within(row2).getByText('Завершено')).toBeInTheDocument();
    expect(within(row2).getByText('Деплой')).toBeInTheDocument(); // stageName DEPLOY
  });

  it('пустое поле service отображается как «—», а не пусто', async () => {
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    const row = screen.getByText('Задача два').closest('tr') as HTMLElement;
    expect(within(row).getByText('—')).toBeInTheDocument();
  });

  it('null-длительность завершённой строки показывается как «Нет данных», а не 0', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [
          makeRow({
            id: 'task-x',
            title: 'Без длительностей',
            status: 'DONE',
            stageCode: 'DEPLOY',
            stageName: 'Деплой',
            timingState: 'completed',
            completedAt: '2026-06-22T11:00:00.000Z',
            stageDurationMs: null,
            totalDurationMs: null,
          }),
        ],
        summary: makeStats().summary,
      }),
    );
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    const row = screen.getByText('Без длительностей').closest('tr') as HTMLElement;
    // Две ячейки длительностей → два «Нет данных».
    expect(within(row).getAllByText('Нет данных').length).toBeGreaterThanOrEqual(2);
    expect(within(row).queryByText('0')).not.toBeInTheDocument();
  });
});

describe('ProjectMonitor — ошибка и повторная загрузка', () => {
  it('при ошибке API показывает состояние ошибки и повторяет запрос по кнопке «Повторить»', async () => {
    getStatsMock.mockRejectedValueOnce(new ApiError('Внутренняя ошибка сервера', 500));
    const user = setupUser();
    renderMonitor();

    // Состояние ошибки.
    expect(await screen.findByText('Не удалось загрузить монитор')).toBeInTheDocument();
    expect(screen.getByText('Внутренняя ошибка сервера')).toBeInTheDocument();
    expect(getStatsMock).toHaveBeenCalledTimes(1);

    // Следующий вызов — успешный.
    getStatsMock.mockResolvedValue(makeStats());
    await user.click(screen.getByRole('button', { name: 'Повторить' }));

    await waitFor(() =>
      expect(screen.queryByText('Не удалось загрузить монитор')).not.toBeInTheDocument(),
    );
    expect(getStatsMock).toHaveBeenCalledTimes(2);
    // Сводка появилась — данные загрузились.
    expect(await screen.findByText('Всего')).toBeInTheDocument();
  });
});

describe('ProjectMonitor — пустой проект', () => {
  it('во вкладке «По задачам» показывает пустое состояние, если задач нет', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [],
        summary: {
          total: 0,
          active: 0,
          completed: 0,
          blocked: 0,
          byStage: {},
          averageCompletedDurationMs: null,
        },
        pagination: { limit: 20, offset: 0, total: 0 },
      }),
    );
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    expect(screen.getByText('В этом проекте пока нет задач')).toBeInTheDocument();
    // Кнопок пагинации нет (таблица не отрисована).
    expect(screen.queryByRole('button', { name: 'Вперёд' })).not.toBeInTheDocument();
  });
});

describe('ProjectMonitor — пагинация', () => {
  it('кнопка «Вперёд» запрашивает следующий offset, «Назад» — предыдущий', async () => {
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    // Первая загрузка: offset 0.
    expect(getStatsMock).toHaveBeenLastCalledWith(
      DB_PROJECT.id,
      expect.objectContaining({ offset: 0 }),
    );

    await user.click(screen.getByRole('button', { name: 'Вперёд' }));
    await waitFor(() =>
      expect(getStatsMock).toHaveBeenLastCalledWith(
        DB_PROJECT.id,
        expect.objectContaining({ offset: 20 }),
      ),
    );

    await user.click(screen.getByRole('button', { name: 'Назад' }));
    await waitFor(() =>
      expect(getStatsMock).toHaveBeenLastCalledWith(
        DB_PROJECT.id,
        expect.objectContaining({ offset: 0 }),
      ),
    );
  });

  it('кнопка «Назад» заблокирована на первой странице', async () => {
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    expect(screen.getByRole('button', { name: 'Назад' })).toBeDisabled();
  });
});

describe('ProjectMonitor — фильтры и сортировка', () => {
  it('фильтр по статусу скрывает строки с другим статусом', async () => {
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    // Изначально видны обе задачи.
    expect(screen.getByText('Задача один')).toBeInTheDocument(); // CODING
    expect(screen.getByText('Задача два')).toBeInTheDocument(); // DONE

    // Фильтруем по статусу «Завершено» (DONE).
    await user.selectOptions(screen.getByLabelText('Статус'), 'DONE');

    expect(screen.queryByText('Задача один')).not.toBeInTheDocument();
    expect(screen.getByText('Задача два')).toBeInTheDocument();
  });

  it('фильтр по этапу с отсутствующими совпадениями показывает «Нет задач под выбранные фильтры»', async () => {
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    // Этап CODING оставляет только «Задача один».
    await user.selectOptions(screen.getByLabelText('Этап'), 'CODING');
    expect(screen.getByText('Задача один')).toBeInTheDocument();
    expect(screen.queryByText('Задача два')).not.toBeInTheDocument();
  });
});

describe('ProjectMonitor — автообновление по таймеру', () => {
  // Эти тесты на фейковых таймерах: проверяем интервал автообновления.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(GENERATED_AT));
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('повторно запрашивает данные через интервал и останавливается после размонтирования', async () => {
    const { unmount } = renderMonitor();

    // Сливаем микрозадачи (register → get) — первая загрузка.
    await vi.advanceTimersByTimeAsync(0);
    expect(getStatsMock).toHaveBeenCalledTimes(1);

    // Прошёл один интервал автообновления (5000мс) — ещё один запрос.
    await vi.advanceTimersByTimeAsync(5000);
    expect(getStatsMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(5000);
    expect(getStatsMock).toHaveBeenCalledTimes(3);

    // После размонтирования таймер очищается — новых запросов нет.
    unmount();
    const callsAfterUnmount = getStatsMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getStatsMock).toHaveBeenCalledTimes(callsAfterUnmount);
  });
});

describe('ProjectMonitor — live-длительности', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Фиксируем «сейчас» = GENERATED_AT, чтобы elapsedSinceFetch стартовал с 0.
    vi.setSystemTime(new Date(GENERATED_AT));
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('длительность активной задачи растёт с тиком, завершённая остаётся неизменной', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [
          makeRow({
            id: 'active-1',
            title: 'Активная задача',
            status: 'CODING',
            stageCode: 'CODING',
            stageName: 'Разработка',
            timingState: 'active',
            stageDurationMs: 30_000, // 30 сек (база этапа)
            totalDurationMs: 600_000, // 10 мин (отлично от значений этапа)
          }),
          makeRow({
            id: 'done-1',
            title: 'Готовая задача',
            status: 'DONE',
            stageCode: 'DEPLOY',
            stageName: 'Деплой',
            timingState: 'completed',
            completedAt: '2026-06-22T11:00:00.000Z',
            stageDurationMs: 45_000, // 45 сек — фиксировано
            totalDurationMs: 120_000,
          }),
        ],
        summary: makeStats().summary,
      }),
    );
    renderMonitor();
    // Сливаем микрозадачи register → get.
    await vi.advanceTimersByTimeAsync(0);
    // Переключаемся на вид «По задачам». fireEvent синхронен и не завязан на
    // таймеры (userEvent под фейковыми таймерами здесь избыточен).
    fireEvent.click(screen.getByRole('tab', { name: 'По задачам' }));

    const activeRow = () => screen.getByText('Активная задача').closest('tr') as HTMLElement;
    const doneRow = () => screen.getByText('Готовая задача').closest('tr') as HTMLElement;

    // На момент загрузки elapsed = 0: активная показывает базовую длительность 30 сек.
    expect(within(activeRow()).getByText('30 сек')).toBeInTheDocument();
    expect(within(doneRow()).getByText('45 сек')).toBeInTheDocument();

    // Продвигаем фейковые таймеры на 4с (< интервала автообновления 5с, чтобы
    // не было silent-перезагрузки, сбрасывающей fetchedAt). Date.now() растёт
    // вместе с таймерами; тик «сейчас» (1с) даёт elapsedSinceFetch = 4000.
    // Активная stageDuration = 30с + 4с = 34 сек.
    await vi.advanceTimersByTimeAsync(4000);

    expect(within(activeRow()).getByText('34 сек')).toBeInTheDocument();
    // Завершённая не изменилась.
    expect(within(doneRow()).getByText('45 сек')).toBeInTheDocument();
    expect(within(activeRow()).queryByText('30 сек')).not.toBeInTheDocument();
  });
});

describe('ProjectMonitor — вид «По ролям» от конфигурации проекта (FRONTEND-P0.2)', () => {
  // Проект с двумя назначенными ролями на включённых этапах.
  const ROLE_ARCH = { id: 'r-arch', name: 'Архитектор', code: 'ARCHITECT' };
  const ROLE_PROG = { id: 'r-prog', name: 'Разработчик', code: 'PROGRAMMER' };
  const PROJECT_WITH_ROLES: Project = {
    ...PROJECT,
    roles: [ROLE_ARCH, ROLE_PROG],
    stages: [
      { id: 's1', name: 'Архитектура', roleIds: ['r-arch'], enabled: true },
      { id: 's2', name: 'Разработка', roleIds: ['r-prog'], enabled: true },
    ],
  };

  it('показывает в панели ролей только роли, назначенные включённым этапам', async () => {
    render(<ProjectMonitor project={PROJECT_WITH_ROLES} onBack={vi.fn()} />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());

    // Вид «По ролям» открыт по умолчанию — обе назначенные роли видны.
    const rolesTable = (await screen.findByRole('region', { name: 'Таблица по ролям' }));
    expect(within(rolesTable).getByText('Архитектор')).toBeInTheDocument();
    expect(within(rolesTable).getByText('Разработчик')).toBeInTheDocument();
    // PROGRAMMER → CODING: счётчик из byStage.CODING = 3.
    const progRow = within(rolesTable).getByText('Разработчик').closest('tr') as HTMLElement;
    expect(within(progRow).getByText('3')).toBeInTheDocument();
  });

  it('после удаления роли из этапов (re-render проекта) она исчезает из панели ролей', async () => {
    const { rerender } = render(<ProjectMonitor project={PROJECT_WITH_ROLES} onBack={vi.fn()} />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    expect(await screen.findByText('Разработчик')).toBeInTheDocument();

    // Удаляем «Разработчик» из этапов проекта и обновляем prop без перезагрузки.
    const PROJECT_WITHOUT_PROG: Project = {
      ...PROJECT_WITH_ROLES,
      stages: [{ id: 's1', name: 'Архитектура', roleIds: ['r-arch'], enabled: true }],
    };
    rerender(<ProjectMonitor project={PROJECT_WITHOUT_PROG} onBack={vi.fn()} />);

    await waitFor(() => expect(screen.queryByText('Разработчик')).not.toBeInTheDocument());
    // Архитектор остаётся — не задет удалением соседней роли.
    expect(screen.getByText('Архитектор')).toBeInTheDocument();
  });

  it('отключённый этап не показывает свою роль, но историческая строка задачи остаётся читаемой', async () => {
    const PROJECT_PROG_DISABLED: Project = {
      ...PROJECT_WITH_ROLES,
      stages: [
        { id: 's1', name: 'Архитектура', roleIds: ['r-arch'], enabled: true },
        { id: 's2', name: 'Разработка', roleIds: ['r-prog'], enabled: false },
      ],
    };
    const user = setupUser();
    render(<ProjectMonitor project={PROJECT_PROG_DISABLED} onBack={vi.fn()} />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());

    // В панели ролей роли отключённого этапа нет.
    const rolesTable = await screen.findByRole('region', { name: 'Таблица по ролям' });
    expect(within(rolesTable).queryByText('Разработчик')).not.toBeInTheDocument();
    expect(within(rolesTable).getByText('Архитектор')).toBeInTheDocument();

    // Но историческая строка задачи в этапе CODING всё ещё показывает stageName из API.
    await switchToTasks(user);
    const taskRow = screen.getByText('Задача один').closest('tr') as HTMLElement;
    expect(within(taskRow).getAllByText('Разработка').length).toBeGreaterThanOrEqual(1);
  });

  it('роль, не назначенная ни одному этапу, не воскресает из статической таблицы', async () => {
    // Проект вообще без этапов: статический ROLE_PIPELINE НЕ должен подставить роли.
    render(<ProjectMonitor project={PROJECT} onBack={vi.fn()} />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    const rolesTable = await screen.findByRole('region', { name: 'Таблица по ролям' });
    // Ни одна из «дефолтных» ролей не появилась.
    expect(within(rolesTable).queryByText('Архитектор')).not.toBeInTheDocument();
    expect(within(rolesTable).queryByText('Разработчик')).not.toBeInTheDocument();
    expect(within(rolesTable).queryByText('Ревьюер')).not.toBeInTheDocument();
  });
});

describe('ProjectMonitor — наблюдаемость (KPI, причина блока, форс-док)', () => {
  it('во вкладке «По задачам» показывает KPI: стоимость и число прогонов (с упавшими)', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [
          makeRow({
            id: 'kpi-1',
            title: 'С расходом токенов',
            kpi: {
              tokenInput: 500_000,
              tokenOutput: 12_000,
              tokenCacheRead: 400_000,
              tokenCacheCreation: 20_000,
              tokenFreshInput: 80_000,
              cost: 79.99,
              turns: 147,
              runs: 12,
              failedRuns: 2,
            },
          }),
        ],
        summary: makeStats().summary,
      }),
    );
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    const row = screen.getByText('С расходом токенов').closest('tr') as HTMLElement;
    expect(within(row).getByText('$79.99')).toBeInTheDocument();
    expect(within(row).getByText('12 прогонов · 2 упавш.')).toBeInTheDocument();
  });

  it('для заблокированной задачи показывает причину блокировки (роль и заметку)', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [
          makeRow({
            id: 'blk-1',
            title: 'Упавшая интеграция',
            status: 'BLOCKED',
            stageCode: 'BLOCKED',
            stageName: 'Заблокировано',
            timingState: 'active',
            blockReason: {
              role: 'GIT_INTEGRATOR',
              note: 'cherry_pick_failed',
              error: null,
              at: '2026-06-22T11:00:00.000Z',
            },
          }),
        ],
        summary: makeStats().summary,
      }),
    );
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    const row = screen.getByText('Упавшая интеграция').closest('tr') as HTMLElement;
    expect(within(row).getByText('GIT_INTEGRATOR: cherry_pick_failed')).toBeInTheDocument();
  });

  it('помечает задачу с форс-продвижением документации бейджем «форс-док»', async () => {
    getStatsMock.mockResolvedValue(
      makeStats({
        tasks: [
          makeRow({
            id: 'doc-1',
            title: 'Док-ветка без прогона',
            status: 'DONE',
            stageCode: 'DONE',
            stageName: 'Завершено',
            timingState: 'completed',
            completedAt: '2026-06-22T11:00:00.000Z',
            docForcedAdvance: true,
          }),
        ],
        summary: makeStats().summary,
      }),
    );
    const user = setupUser();
    renderMonitor();
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    await switchToTasks(user);

    const row = screen.getByText('Док-ветка без прогона').closest('tr') as HTMLElement;
    expect(within(row).getByText('форс-док')).toBeInTheDocument();
  });
});

describe('ProjectMonitor — отмена устаревших запросов при смене проекта', () => {
  it('при смене проекта перезагружает данные нового проекта (register с новой папкой)', async () => {
    const onBack = vi.fn();
    const { rerender } = render(<ProjectMonitor project={PROJECT} onBack={onBack} />);
    await waitFor(() => expect(getStatsMock).toHaveBeenCalled());
    expect(registerMock).toHaveBeenCalledWith({
      name: PROJECT.name,
      path: PROJECT.path,
    });

    // Меняем проект — компонент должен повторно привязаться по новой папке.
    const PROJECT_2: Project = {
      ...PROJECT,
      id: 'proj_local_2',
      name: 'Проект Бета',
      path: '/repos/beta',
    };
    const DB_PROJECT_2 = { ...DB_PROJECT, id: 'uuid-beta-0002' };
    registerMock.mockResolvedValue(DB_PROJECT_2);

    rerender(<ProjectMonitor project={PROJECT_2} onBack={onBack} />);

    await waitFor(() =>
      expect(registerMock).toHaveBeenLastCalledWith({
        name: 'Проект Бета',
        path: '/repos/beta',
      }),
    );
    // Статистика нового проекта запрашивается по его UUID (данные не смешиваются).
    await waitFor(() =>
      expect(getStatsMock).toHaveBeenLastCalledWith(
        DB_PROJECT_2.id,
        expect.objectContaining({ offset: 0 }),
      ),
    );
  });
});
