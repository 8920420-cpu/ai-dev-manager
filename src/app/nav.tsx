import { Activity, Bot, FolderGit2, ListTree, Plug, Server, Settings, Workflow, type LucideIcon } from 'lucide-react';
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
  {
    label: 'Задачи',
    route: 'tasks',
    icon: ListTree,
    children: [
      { label: 'Проверка', route: 'tasks-review' },
      // Очередь задач, остановленных на вопросе к человеку — рядом с «Проверкой»,
      // потому что обе требуют действия человека, а не работы конвейера.
      { label: 'Нужна информация', route: 'tasks-needs-input' },
      { label: 'В работе', route: 'tasks' },
      { label: 'Выполнено', route: 'tasks-done' },
    ],
  },
  {
    label: 'Отделы',
    route: 'departments-development',
    icon: Workflow,
    children: [
      { label: 'Разработка', route: 'departments-development' },
    ],
  },
  { label: 'Монитор производительности', route: 'monitor-performance', icon: Activity },
  { label: 'MCP роли', route: 'mcp-roles', icon: Bot },
  { label: 'Серверы', route: 'servers', icon: Server },
  { label: 'Интеграции', route: 'integrations', icon: Plug },
  {
    label: 'Настройки',
    route: 'settings-roles',
    icon: Settings,
    children: [
      { label: 'Роли', route: 'settings-roles' },
      { label: 'Базы данных', route: 'settings-databases' },
      { label: 'Инструменты', route: 'settings-tools' },
      { label: 'Выполнение', route: 'settings-execution' },
    ],
  },
];
