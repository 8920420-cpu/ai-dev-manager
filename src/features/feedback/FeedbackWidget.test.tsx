import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const send = vi.fn();
const uploadScreenshot = vi.fn();
vi.mock('../../api/feedbackApi', () => ({
  feedbackApi: {
    send: (...args: unknown[]) => send(...args),
    uploadScreenshot: (...args: unknown[]) => uploadScreenshot(...args),
  },
}));

import { FeedbackWidget } from './FeedbackWidget';
import { ToastProvider } from '../../components/ui/Toast';
import { RouterProvider } from '../../app/router';

function renderWidget() {
  return render(
    <ToastProvider>
      <RouterProvider>
        <FeedbackWidget />
      </RouterProvider>
    </ToastProvider>,
  );
}

describe('FeedbackWidget — виджет «Обратная связь»', () => {
  beforeEach(() => {
    send.mockReset();
    uploadScreenshot.mockReset();
    window.location.hash = '#/tasks';
    try {
      localStorage.clear();
    } catch {
      /* noop */
    }
  });

  it('кнопка доступна; сценарий категория → текст → проверка → отправка → номер заявки', async () => {
    const user = userEvent.setup();
    send.mockResolvedValue({ accepted: true, reportNumber: 42 });
    renderWidget();

    // Плавающая кнопка доступна.
    await user.click(screen.getByRole('button', { name: /Обратная связь/i }));

    // Шаг 1: выбрать категорию «Идея».
    await user.click(screen.getByRole('radio', { name: /Идея/i }));
    await user.click(screen.getByRole('button', { name: 'Далее' }));

    // Шаг 2: текст сообщения.
    await user.type(
      screen.getByLabelText(/Сообщение/i),
      'Не хватает тёмной темы в списке задач',
    );
    await user.click(screen.getByRole('button', { name: 'Далее' }));

    // Шаг 3: проверка данных.
    expect(screen.getByText(/💡 Идея/)).toBeInTheDocument();
    expect(screen.getByText('Не хватает тёмной темы в списке задач')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    // Номер заявки из ответа.
    expect(await screen.findByText(/Заявка №42 принята/)).toBeInTheDocument();

    // Контракт payload.
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0]![0];
    expect(payload.category).toBe('idea');
    expect(payload.service).toBe('orchestrator-ui');
    expect(payload.form).toBe('tasks');
    expect(payload.message).toBe('Не хватает тёмной темы в списке задач');
    expect(typeof payload.externalId).toBe('string');
    expect(payload.externalId.length).toBeGreaterThan(0);
    expect(payload.autocontext).toBeTruthy();
    expect(Array.isArray(payload.autocontext.jsErrors)).toBe(true);
    // Скриншот не запрашивали — загрузки не было.
    expect(uploadScreenshot).not.toHaveBeenCalled();
  });

  it('категория по умолчанию — «Нашёл ошибку» (bug)', async () => {
    const user = userEvent.setup();
    send.mockResolvedValue({ accepted: true, reportNumber: 1 });
    renderWidget();

    await user.click(screen.getByRole('button', { name: /Обратная связь/i }));
    // Категорию не меняем — остаётся дефолт.
    await user.click(screen.getByRole('button', { name: 'Далее' }));
    await user.type(screen.getByLabelText(/Сообщение/i), 'Кнопка не срабатывает');
    await user.click(screen.getByRole('button', { name: 'Далее' }));
    await user.click(screen.getByRole('button', { name: 'Отправить' }));

    await screen.findByText(/Заявка №1 принята/);
    expect(send.mock.calls[0]![0].category).toBe('bug');
  });
});
