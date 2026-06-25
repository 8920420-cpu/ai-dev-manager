import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '../../components/ui';
import { ProjectPauseBanner } from './ProjectPauseBanner';
import type { Project } from '../../types/project';

const setStatus = vi.fn();
vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    setStatus: (...a: unknown[]) => setStatus(...a),
  },
}));

const BASE: Project = {
  id: 'p1',
  name: 'Альфа',
  path: '/repos/alpha',
  status: 'paused',
  pauseReason: 'Контракты ролей рассинхронизированы',
  stages: [],
  roles: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function renderBanner(project: Project, onResumed = vi.fn()) {
  render(
    <ToastProvider>
      <ProjectPauseBanner project={project} onResumed={onResumed} />
    </ToastProvider>,
  );
  return { onResumed };
}

beforeEach(() => {
  setStatus.mockReset();
});

describe('ProjectPauseBanner', () => {
  it('не рендерится для активного проекта', () => {
    renderBanner({ ...BASE, status: 'active' });
    expect(screen.queryByText(/Проект на паузе/i)).not.toBeInTheDocument();
  });

  it('показывает причину паузы и кнопку «Снять паузу»', () => {
    renderBanner(BASE);
    expect(screen.getByText(/Проект на паузе/i)).toBeInTheDocument();
    expect(screen.getByText(/Контракты ролей рассинхронизированы/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Снять паузу/i })).toBeInTheDocument();
  });

  it('кнопка «Снять паузу» вызывает setStatus(active) и отдаёт обновлённый проект', async () => {
    const user = userEvent.setup();
    const resumed: Project = { ...BASE, status: 'active', pauseReason: null };
    setStatus.mockResolvedValue(resumed);
    const { onResumed } = renderBanner(BASE);

    await user.click(screen.getByRole('button', { name: /Снять паузу/i }));

    await waitFor(() => expect(setStatus).toHaveBeenCalledWith('p1', 'active'));
    expect(onResumed).toHaveBeenCalledWith(resumed);
  });
});
