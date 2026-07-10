import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import styles from './Menu.module.css';

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
}

interface MenuProps {
  items: MenuItem[];
  /** Доступная подпись кнопки-триггера. */
  label?: string;
  align?: 'start' | 'end';
}

/** Доступное меню действий «⋯» с управлением с клавиатуры. */
export function Menu({ items, label = 'Действия', align = 'end' }: MenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  const focusItem = (idx: number) => {
    const n = items.length;
    const next = ((idx % n) + n) % n;
    itemRefs.current[next]?.focus();
  };

  return (
    <div className={styles.root} ref={rootRef}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          className={cn(styles.menu, align === 'end' ? styles.end : styles.start)}
          role="menu"
          onKeyDown={(e) => {
            const current = itemRefs.current.findIndex(
              (el) => el === document.activeElement,
            );
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              focusItem(current + 1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              focusItem(current - 1);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              className={cn(styles.item, item.tone === 'danger' && styles.danger)}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.icon && <span className={styles.itemIcon}>{item.icon}</span>}
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
