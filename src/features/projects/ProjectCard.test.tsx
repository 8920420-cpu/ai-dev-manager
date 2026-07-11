import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProjectCard } from './ProjectCard';
import type { Project } from '../../types/project';

// Проект с этапами, ролями и выключенным Scanner — раньше это давало на карточке
// подписи «N этапов», «N ролей» и тумблер «Scanner / выкл», которые нужно убрать.
const BASE: Project = {
  id: 'p1',
  name: 'Альфа',
  path: '/repos/alpha',
  status: 'active',
  pauseReason: null,
  stages: [
    { id: 's1', name: 'Приём', roleIds: ['r1'], enabled: true },
    { id: 's2', name: 'Разработка', roleIds: ['r2'], enabled: false },
  ],
  roles: [
    { id: 'r1', name: 'Приёмщик' },
    { id: 'r2', name: 'Разработчик' },
  ],
  scannerEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
};

function renderCard(project: Project = BASE) {
  render(
    <ProjectCard
      project={project}
      onOpen={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
    />,
  );
}

describe('ProjectCard', () => {
  it('не показывает подписи «Этапы», «Назначено ролей» и тумблер Scanner', () => {
    renderCard();

    // Подписи об этапах и ролях удалены.
    expect(screen.queryByText(/этап/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/рол(ь|и|ей)/i)).not.toBeInTheDocument();

    // Интерактивный тумблер Scanner удалён.
    expect(screen.queryByText(/scanner/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('оставляет имя, путь, статус и дату изменения', () => {
    renderCard();

    expect(
      screen.getByRole('button', { name: /Открыть монитор задач проекта Альфа/i }),
    ).toBeInTheDocument();
    expect(screen.getByText('/repos/alpha')).toBeInTheDocument();
    expect(screen.getByText('Активен')).toBeInTheDocument();
    expect(screen.getByText(/Изменён/)).toBeInTheDocument();
  });
});
