import styles from './Logo.module.css';

/** Компактный логотип/название AI Dev Manager. */
export function Logo({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <span className={styles.logo} aria-label="AI Dev Manager">
      <span className={styles.mark} aria-hidden="true">
        <svg viewBox="0 0 32 32" width="28" height="28" fill="none">
          <rect width="32" height="32" rx="7" fill="var(--primary)" />
          <path
            d="M10.5 11.5 7 16l3.5 4.5"
            stroke="#fff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M21.5 11.5 25 16l-3.5 4.5"
            stroke="#fff"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M17.5 9.5 14.5 22.5"
            stroke="var(--brand-300)"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </span>
      {!collapsed && (
        <span className={styles.text}>
          <span className={styles.name}>AI Dev Manager</span>
          <span className={styles.sub}>Панель управления</span>
        </span>
      )}
    </span>
  );
}
