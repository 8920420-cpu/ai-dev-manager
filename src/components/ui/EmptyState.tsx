import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** Вариант для ошибок. */
  tone?: 'default' | 'error';
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'default',
}: EmptyStateProps) {
  return (
    <div className={styles.wrap} data-tone={tone}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <h3 className={styles.title}>{title}</h3>
      {description && <p className={styles.desc}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
