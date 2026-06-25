import { FolderGit2, Plug, Settings, Workflow, type LucideIcon } from 'lucide-react';
import type { RouteKey } from './router';

export interface NavChild {
  label: string;
  route: RouteKey;
}

export interface NavItem {
  label: string;
  route: RouteKey;
  icon: LucideIcon;
  children?: NavChild[];
}

/** Структура бокового меню. */
export const NAV_ITEMS: NavItem[] = [
  {
    // Подгруппа проектов формируется динамически из списка проектов (см. Sidebar).
    label: 'Проекты',
    route: 'projects',
    icon: FolderGit2,
  },
  { label: 'Схема разработки', route: 'development-scheme', icon: Workflow },
  { label: 'Интеграции', route: 'integrations', icon: Plug },
  {
    label: 'Настройки',
    route: 'settings-roles',
    icon: Settings,
    children: [
      { label: 'Роли', route: 'settings-roles' },
      { label: 'Инструменты', route: 'settings-tools' },
    ],
  },
];
