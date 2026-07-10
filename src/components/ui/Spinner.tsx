import { cn } from '../../lib/cn';
import styles from './Spinner.module.css';

interface SpinnerProps {
  size?: number;
  label?: string;
  className?: string;
}

/** Индикатор загрузки. По умолчанию доступен скринридеру. */
export function Spinner({ size = 18, label = 'Загрузка', className }: SpinnerProps) {
  return (
    <span
      className={cn(styles.spinner, className)}
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
    />
  );
}

/** Центрированный блок загрузки для пустого контента. */
export function LoadingBlock({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className={styles.block}>
      <Spinner size={24} />
      <span className={styles.blockLabel}>{label}</span>
    </div>
  );
}
