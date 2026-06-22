import { useEffect, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { cn } from '../../lib/cn';
import { NAV_ITEMS } from '../../app/nav';
import { useRouter } from '../../app/router';
import { projectsApi } from '../../api/projectsApi';
import { STORE_CHANGE_EVENT } from '../../api/localStore';
import type { Project } from '../../types/project';
import { Logo } from './Logo';
import styles from './Sidebar.module.css';

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /** Вызывается при выборе пункта (чтобы закрыть мобильный drawer). */
  onNavigate?: () => void;
}

export function Sidebar({ collapsed, onToggleCollapse, onNavigate }: SidebarProps) {
  const { route, navigate, href } = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);

  // Список проектов для подгруппы меню; обновляется при изменениях в хранилище.
  useEffect(() => {
    let alive = true;
    const load = () => {
      projectsApi
        .list()
        .then((list) => {
          if (alive) setProjects(list);
        })
        .catch(() => {
          if (alive) setProjects([]);
        });
    };
    load();
    const onChange = (e: Event) => {
      if ((e as CustomEvent<{ key: string }>).detail?.key === 'projects') load();
    };
    window.addEventListener(STORE_CHANGE_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(STORE_CHANGE_EVENT, onChange);
    };
  }, []);

  const go = (to: typeof route) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
    onNavigate?.();
  };

  return (
    <div className={cn(styles.sidebar, collapsed && styles.collapsed)}>
      <div className={styles.brand}>
        <Logo collapsed={collapsed} />
      </div>

      <nav className={styles.nav} aria-label="Основная навигация">
        <ul className={styles.list}>
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active =
              route === item.route ||
              (item.children?.some((child) => child.route === route) ?? false);
            return (
              <li key={item.label}>
                <a
                  href={href(item.route)}
                  className={cn(styles.item, active && styles.active)}
                  aria-current={active ? 'page' : undefined}
                  title={collapsed ? item.label : undefined}
                  onClick={go(item.route)}
                >
                  <span className={styles.itemIcon}>
                    <Icon size={18} aria-hidden="true" />
                  </span>
                  <span className={styles.itemLabel}>{item.label}</span>
                </a>

                {item.route === 'projects' && !collapsed && (
                  <ul className={styles.sublist}>
                    {projects.length === 0 ? (
                      <li>
                        <span className={cn(styles.subitem, styles.subempty)}>
                          Нет проектов
                        </span>
                      </li>
                    ) : (
                      projects.map((project) => (
                        <li key={project.id}>
                          <a
                            href={href('projects')}
                            className={styles.subitem}
                            title={project.name}
                            onClick={go('projects')}
                          >
                            {project.name}
                          </a>
                        </li>
                      ))
                    )}
                  </ul>
                )}

                {item.route !== 'projects' && item.children && !collapsed && (
                  <ul className={styles.sublist}>
                    {item.children.map((child) => {
                      const childActive = route === child.route;
                      return (
                        <li key={child.label}>
                          <a
                            href={href(child.route)}
                            className={cn(
                              styles.subitem,
                              childActive && styles.subactive,
                            )}
                            aria-current={childActive ? 'page' : undefined}
                            onClick={go(child.route)}
                          >
                            {child.label}
                          </a>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <button
        type="button"
        className={styles.collapseBtn}
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
        title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
      >
        {collapsed ? (
          <PanelLeftOpen size={18} aria-hidden="true" />
        ) : (
          <PanelLeftClose size={18} aria-hidden="true" />
        )}
        <span className={styles.collapseLabel}>Свернуть</span>
      </button>
    </div>
  );
}
