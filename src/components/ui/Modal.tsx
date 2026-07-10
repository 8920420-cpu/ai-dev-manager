import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import styles from './Modal.module.css';

type Size = 'sm' | 'md' | 'lg' | 'xl';

interface ModalProps {
  open: boolean;
  /**
   * Запрос на закрытие. Вызывается ТОЛЬКО по явному нажатию пользователя на
   * видимую кнопку внутри окна (крестик, «Отмена», «Закрыть»). Закрытие по клику
   * на фон, по `Escape` или потере фокуса намеренно не поддерживается —
   * см. общее правило в корневом `TASKS.md`.
   */
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  size?: Size;
  children: ReactNode;
  footer?: ReactNode;
  footerStart?: ReactNode;
}

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  size = 'md',
  children,
  footer,
  footerStart,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const subId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Блокировка прокрутки фона + возврат фокуса при закрытии.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // Фокус на первый интерактивный элемент / диалог.
    const node = dialogRef.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();

    return () => {
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Только удержание фокуса внутри окна (focus trap). Escape намеренно НЕ закрывает
  // модальное окно — закрытие выполняется лишь явной кнопкой внутри окна.
  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const node = dialogRef.current;
    if (!node) return;
    const items = Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  if (!open) return null;

  return createPortal(
    // Клик по фону намеренно не закрывает окно: закрытие — только явной кнопкой внутри.
    <div className={styles.scrim}>
      <div
        ref={dialogRef}
        className={cn(styles.dialog, styles[size])}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className={styles.head}>
          <div className={styles.titleWrap}>
            <h2 className={styles.title} id={titleId}>
              {title}
            </h2>
            {subtitle && (
              <p className={styles.subtitle} id={subId}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>{children}</div>

        {(footer || footerStart) && (
          <footer className={styles.footer}>
            {footerStart && <div className={styles.footerStart}>{footerStart}</div>}
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
