import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import styles from './AppShell.module.css';

const COLLAPSE_KEY = 'adm.sidebar.collapsed';

export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
    } catch {
      /* noop */
    }
  }, [collapsed]);

  // Закрытие drawer по Esc.
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mobileOpen]);

  return (
    <div className={cn(styles.shell, collapsed && styles.collapsed)}>
      <a href="#main" className="skip-link">
        К основному содержимому
      </a>

      {/* Десктоп: постоянный сайдбар */}
      <aside className={styles.desktopSidebar} aria-label="Боковое меню">
        <Sidebar
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
        />
      </aside>

      {/* Мобайл: выезжающая панель */}
      <div
        className={cn(styles.drawerScrim, mobileOpen && styles.drawerOpen)}
        onClick={() => setMobileOpen(false)}
        aria-hidden={!mobileOpen}
      />
      <aside
        className={cn(styles.mobileSidebar, mobileOpen && styles.mobileOpen)}
        aria-label="Боковое меню"
        aria-hidden={!mobileOpen}
        // off-screen drawer не должен быть в порядке табуляции, когда закрыт
        {...(!mobileOpen ? { inert: true } : {})}
      >
        <Sidebar
          collapsed={false}
          onToggleCollapse={() => setMobileOpen(false)}
          onNavigate={() => setMobileOpen(false)}
        />
      </aside>

      <div className={styles.main}>
        <Topbar onOpenMobileNav={() => setMobileOpen(true)} />
        <main className={styles.content} id="main" tabIndex={-1}>
          <div className={styles.container}>{children}</div>
        </main>
      </div>
    </div>
  );
}
