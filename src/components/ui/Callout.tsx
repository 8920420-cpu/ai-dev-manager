import type { ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info } from 'lucide-react';
import styles from './Callout.module.css';

type Tone = 'info' | 'success' | 'warning' | 'error';

const ICONS: Record<Tone, ReactNode> = {
  info: <Info size={16} aria-hidden="true" />,
  success: <CheckCircle2 size={16} aria-hidden="true" />,
  warning: <AlertTriangle size={16} aria-hidden="true" />,
  error: <XCircle size={16} aria-hidden="true" />,
};

interface CalloutProps {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  /** role=alert для динамически появляющихся ошибок. */
  live?: boolean;
}

/** Встроенный информационный/статусный блок. */
export function Callout({ tone = 'info', title, children, live }: CalloutProps) {
  return (
    <div
      className={styles.callout}
      data-tone={tone}
      role={live ? 'alert' : undefined}
    >
      <span className={styles.icon}>{ICONS[tone]}</span>
      <div className={styles.body}>
        {title && <p className={styles.title}>{title}</p>}
        {children && <div className={styles.text}>{children}</div>}
      </div>
    </div>
  );
}
