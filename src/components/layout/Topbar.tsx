import { Menu as MenuIcon, Moon, Sun } from 'lucide-react';
import { useTheme } from '../../theme/ThemeProvider';
import { useRouter, type RouteKey } from '../../app/router';
import styles from './Topbar.module.css';

const TITLES: Record<RouteKey, string> = {
  projects: 'Проекты',
  tasks: 'Задачи · В работе',
  'tasks-review': 'Задачи · Проверка',
  'tasks-done': 'Задачи · Выполнено',
  'departments-development': 'Разработка',
  'monitor-performance': 'Монитор производительности',
  integrations: 'Интеграции',
  'settings-roles': 'Настройки · Роли',
  'settings-tools': 'Настройки · Инструменты',
  'settings-execution': 'Настройки · Выполнение',
};

interface TopbarProps {
  onOpenMobileNav: () => void;
}

export function Topbar({ onOpenMobileNav }: TopbarProps) {
  const { theme, toggleTheme } = useTheme();
  const { route } = useRouter();

  return (
    <header className={styles.topbar}>
      <div className={styles.left}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={onOpenMobileNav}
          aria-label="Открыть меню"
        >
          <MenuIcon size={20} aria-hidden="true" />
        </button>
        <h1 className={styles.pageTitle}>{TITLES[route]}</h1>
      </div>

      <div className={styles.right}>
        <button
          type="button"
          className={styles.iconBtn}
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
          title={theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        >
          {theme === 'dark' ? (
            <Sun size={18} aria-hidden="true" />
          ) : (
            <Moon size={18} aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
