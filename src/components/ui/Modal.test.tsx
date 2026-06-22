import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Modal } from './Modal';

function renderModal(onClose = vi.fn()) {
  render(
    <Modal open onClose={onClose} title="Тест">
      <p>Содержимое</p>
    </Modal>,
  );
  return onClose;
}

describe('Modal — закрытие только явной кнопкой', () => {
  it('закрывается по нажатию на кнопку-крестик', async () => {
    const user = userEvent.setup();
    const onClose = renderModal();
    await user.click(screen.getByRole('button', { name: /Закрыть/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('НЕ закрывается по нажатию Escape', () => {
    const onClose = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('НЕ закрывается по клику на фон (scrim)', () => {
    const onClose = renderModal();
    const scrim = screen.getByRole('dialog').parentElement!;
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });
});
