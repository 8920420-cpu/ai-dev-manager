import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';
import styles from './Badge.module.css';
import type { ConnectionState } from '../../types/common';
import type { ProjectStatus } from '../../types/project';

export type BadgeTone =
  | 'neutral'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'primary';

interface BadgeProps {
  tone?: BadgeTone;
  dot?: boolean;
  pulse?: boolean;
  children: ReactNode;
}

export function Badge({ tone = 'neutral', dot = true, pulse, children }: BadgeProps) {
  return (
    <span className={cn(styles.badge, styles[tone], pulse && styles.pulse)}>
      {dot && <span className={styles.dot} aria-hidden="true" />}
      {children}
    </span>
  );
}

const PROJECT_TONE: Record<ProjectStatus, BadgeTone> = {
  active: 'success',
  paused: 'warning',
  draft: 'neutral',
  archived: 'neutral',
};
const PROJECT_LABEL: Record<ProjectStatus, string> = {
  active: 'Активен',
  paused: 'На паузе',
  draft: 'Черновик',
  archived: 'В архиве',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  return <Badge tone={PROJECT_TONE[status]}>{PROJECT_LABEL[status]}</Badge>;
}

const CONN_TONE: Record<ConnectionState, BadgeTone> = {
  unknown: 'neutral',
  checking: 'info',
  success: 'success',
  error: 'danger',
};
const CONN_LABEL: Record<ConnectionState, string> = {
  unknown: 'Не проверено',
  checking: 'Проверка…',
  success: 'Подключено',
  error: 'Ошибка',
};

export function ConnectionBadge({ state }: { state: ConnectionState }) {
  return (
    <Badge tone={CONN_TONE[state]} pulse={state === 'checking'}>
      {CONN_LABEL[state]}
    </Badge>
  );
}
