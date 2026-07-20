import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import type { NeedsInputBoard } from '../../api/tasksApi';

// --- Моки сетевых клиентов страницы ---------------------------------------
// Страница ходит в доску вопросов, в список проектов и подписывается на SSE —
// мокаем всё, чтобы тест был детерминирован и не открывал EventSource.
const needsInputBoard = vi.fn();
const answerQuestion = vi.fn();
vi.mock('../../api/tasksApi', () => ({
  subscribeTaskChanges: () => () => {},
  tasksApi: {
    needsInputBoard: (...a: unknown[]) => needsInputBoard(...a),
    answerQuestion: (...a: unknown[]) => answerQuestion(...a),
  },
}));

vi.mock('../../api/projectsApi', () => ({
  projectsApi: { list: () => Promise.resolve([]) },
}));

import { ToastProvider } from '../../components/ui';
import { NeedsInputPage } from './NeedsInputPage';

const QUESTION = 'Какой формат даты использовать для birth_date?';

/** Доска с одной задачей; варианты ответа задаются тестом. */
function board(options: string[] = []): NeedsInputBoard {
  return {
    tasks: [
      {
        id: 't1',
        title: 'Импорт контактов из 1С',
        projectId: 'p1',
        projectName: 'Альфа',
        serviceCode: 'getway',
        priority: 2,
        question: {
          id: 'q1',
          question: QUESTION,
          options,
          context: 'В выгрузке встречаются и ISO, и DD.MM.YYYY.',
          roleCode: 'PROGRAMMER',
          askedAt: '2026-07-01T10:00:00.000Z',
        },
      },
    ],
  };
}

function renderPage() {
  render(
    <ToastProvider>
      <NeedsInputPage />
    </ToastProvider>,
  );
}

/** Дождаться загрузки доски и открыть модалку ответа кликом по строке. */
async function openModal(user: ReturnType<typeof userEvent.setup>) {
  const row = await screen.findByRole('button', { name: /Импорт контактов из 1С/ });
  await user.click(row);
  return screen.findByRole('dialog');
}

beforeEach(() => {
  needsInputBoard.mockReset();
  answerQuestion.mockReset();
});

describe('NeedsInputPage — очередь вопросов', () => {
  it('показывает задачу с вопросом агента в таблице', async () => {
    needsInputBoard.mockResolvedValue(board());
    renderPage();

    expect(await screen.findByText('Импорт контактов из 1С')).toBeInTheDocument();
    expect(screen.getByText(QUESTION)).toBeInTheDocument();
    expect(screen.getByText('Альфа')).toBeInTheDocument();
  });

  it('показывает пустое состояние, когда никто не ждёт ответа', async () => {
    needsInputBoard.mockResolvedValue({ tasks: [] });
    renderPage();

    expect(await screen.findByText(/Вопросов нет/i)).toBeInTheDocument();
  });

  it('показывает ошибку с кнопкой «Повторить», если доска не загрузилась', async () => {
    needsInputBoard.mockRejectedValue(new Error('boom'));
    renderPage();

    expect(await screen.findByText(/Не удалось загрузить задачи/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Повторить/i })).toBeInTheDocument();
  });
});

describe('NeedsInputPage — модалка ответа', () => {
  it('показывает вопрос, роль и контекст', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board());
    renderPage();

    const dialog = await openModal(user);

    expect(dialog).toHaveTextContent(QUESTION);
    expect(dialog).toHaveTextContent('PROGRAMMER');
    expect(dialog).toHaveTextContent('В выгрузке встречаются и ISO, и DD.MM.YYYY.');
  });

  it('кнопка «Ответить» заблокирована, пока ответ пуст', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board());
    renderPage();
    await openModal(user);

    expect(screen.getByRole('button', { name: /Ответить/i })).toBeDisabled();
  });

  it('свободный текст разблокирует кнопку и уходит в answerQuestion', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board());
    answerQuestion.mockResolvedValue({ answered: true, taskId: 't1', resumedStatus: 'CODING' });
    renderPage();
    await openModal(user);

    await user.type(screen.getByLabelText(/Ответ/), 'Всегда ISO-8601');
    const submit = screen.getByRole('button', { name: /Ответить/i });
    expect(submit).toBeEnabled();
    await user.click(submit);

    await waitFor(() =>
      expect(answerQuestion).toHaveBeenCalledWith('t1', {
        questionId: 'q1',
        answer: 'Всегда ISO-8601',
      }),
    );
  });

  it('выбранный вариант — достаточный ответ, даже без пояснения', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board(['ISO-8601', 'DD.MM.YYYY']));
    answerQuestion.mockResolvedValue({ answered: true, taskId: 't1', resumedStatus: 'CODING' });
    renderPage();
    await openModal(user);

    // Пока вариант не выбран и текста нет — отвечать нечем.
    expect(screen.getByRole('button', { name: /Ответить/i })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText(/Вариант ответа/), 'ISO-8601');
    await user.click(screen.getByRole('button', { name: /Ответить/i }));

    await waitFor(() =>
      expect(answerQuestion).toHaveBeenCalledWith('t1', {
        questionId: 'q1',
        answer: 'ISO-8601',
      }),
    );
  });

  it('вариант вместе с пояснением уходят одной строкой', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board(['ISO-8601', 'DD.MM.YYYY']));
    answerQuestion.mockResolvedValue({ answered: true, taskId: 't1', resumedStatus: 'CODING' });
    renderPage();
    await openModal(user);

    await user.selectOptions(screen.getByLabelText(/Вариант ответа/), 'ISO-8601');
    await user.type(screen.getByLabelText(/Пояснение/), 'Остальное — на входе нормализовать');
    await user.click(screen.getByRole('button', { name: /Ответить/i }));

    await waitFor(() =>
      expect(answerQuestion).toHaveBeenCalledWith('t1', {
        questionId: 'q1',
        answer: 'ISO-8601\nОстальное — на входе нормализовать',
      }),
    );
  });

  it('после успешного ответа доска перезагружается', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board());
    answerQuestion.mockResolvedValue({ answered: true, taskId: 't1', resumedStatus: 'CODING' });
    renderPage();
    await openModal(user);

    await user.type(screen.getByLabelText(/Ответ/), 'ISO');
    await user.click(screen.getByRole('button', { name: /Ответить/i }));

    // Первый вызов — начальная загрузка, второй — перезагрузка после ответа.
    await waitFor(() => expect(needsInputBoard).toHaveBeenCalledTimes(2));
  });

  it('ошибка сервера показывается тостом, модалка остаётся открытой', async () => {
    const user = userEvent.setup();
    needsInputBoard.mockResolvedValue(board());
    answerQuestion.mockRejectedValue(new Error('На этот вопрос уже ответили.'));
    renderPage();
    await openModal(user);

    await user.type(screen.getByLabelText(/Ответ/), 'ISO');
    await user.click(screen.getByRole('button', { name: /Ответить/i }));

    expect(await screen.findByText('На этот вопрос уже ответили.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
