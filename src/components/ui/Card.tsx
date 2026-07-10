import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';
import styles from './Card.module.css';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean;
  pad?: boolean;
}

export function Card({ interactive, pad, className, children, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        styles.card,
        interactive && styles.interactive,
        pad && styles.pad,
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  id?: string;
}

/** Карточка-секция с заголовком (для страницы настроек и форм). */
export function Section({ title, description, actions, children, id }: SectionProps) {
  return (
    <section className={styles.section} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className={styles.sectionHead}>
        <div className={styles.sectionTitleWrap}>
          <h2 className={styles.sectionTitle} id={id ? `${id}-title` : undefined}>
            {title}
          </h2>
          {description && <p className={styles.sectionDesc}>{description}</p>}
        </div>
        {actions}
      </header>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}
