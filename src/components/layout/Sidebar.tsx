import { useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { NAV_ITEMS } from '../../app/nav';
import { useRouter } from '../../app/router';
import { projectsApi, PROJECTS_CHANGED_EVENT } from '../../api/projectsApi';
import { requestOpenProjectMonitor } from '../../app/projectMonitorBus';
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
  // Единый идентификатор раскрытой категории (route категории) либо null.
  // Одновременно раскрыта не более одной категории.
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

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
    // Перезагружаем список при мутациях проектов (create/update/remove/setStatus).
    const onChange = () => load();
    window.addEventListener(PROJECTS_CHANGED_EVENT, onChange);
    return () => {
      alive = false;
      window.removeEventListener(PROJECTS_CHANGED_EVENT, onChange);
    };
  }, []);

  const go = (to: typeof route) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate(to);
    onNavigate?.();
  };

  // Клик по проекту в меню: перейти в раздел «Проекты» и открыть его монитор.
  const openProject = (projectId: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    navigate('projects');
    requestOpenProjectMonitor(projectId);
    onNavigate?.();
  };

  // Переключение раскрытия категории: повторный клик сворачивает, открытие
  // другой категории автоматически сворачивает предыдущую.
  const toggleCategory = (categoryId: string) => () => {
    setExpandedCategory((prev) => (prev === categoryId ? null : categoryId));
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
            // «Проекты» — категория с динамическим подсписком, остальные — со
            // статическими children. Это и есть «категории» (со сворачиванием).
            const isCategory = item.route === 'projects' || !!item.children;
            const sublistId = `nav-sublist-${item.route}`;
            // В свёрнутом режиме подсписки скрыты — категория не считается раскрытой.
            const expanded = !collapsed && expandedCategory === item.route;

            return (
              <li key={item.label}>
                <div className={styles.itemRow}>
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

                  {isCategory && !collapsed && (
                    <button
                      type="button"
                      className={styles.disclosure}
                      aria-expanded={expanded}
                      aria-controls={sublistId}
                      aria-label={
                        expanded
                          ? `Свернуть «${item.label}»`
                          : `Раскрыть «${item.label}»`
                      }
                      onClick={toggleCategory(item.route)}
                    >
                      {expanded ? (
                        <ChevronDown size={16} aria-hidden="true" />
                      ) : (
                        <ChevronRight size={16} aria-hidden="true" />
                      )}
                    </button>
                  )}
                </div>

                {item.route === 'projects' && expanded && (
                  <ul id={sublistId} className={styles.sublist}>
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
                            title={`Открыть монитор проекта «${project.name}»`}
                            onClick={openProject(project.id)}
                          >
                            {project.name}
                          </a>
                        </li>
                      ))
                    )}
                  </ul>
                )}

                {item.route !== 'projects' && item.children && expanded && (
                  <ul id={sublistId} className={styles.sublist}>
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
