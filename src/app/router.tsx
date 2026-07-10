import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

/** Ключи разделов приложения. Совпадают с hash-путями для deep-linking. */
export type RouteKey =
  | 'projects'
  | 'tasks'
  | 'tasks-review'
  | 'tasks-done'
  | 'departments-development'
  | 'servers'
  | 'integrations'
  | 'monitor-performance'
  | 'mcp-roles'
  | 'settings-roles'
  | 'settings-databases'
  | 'settings-tools'
  | 'settings-execution';

const ROUTES: Record<RouteKey, string> = {
  projects: '#/projects',
  tasks: '#/tasks',
  'tasks-review': '#/tasks/review',
  'tasks-done': '#/tasks/done',
  'departments-development': '#/departments/development',
  servers: '#/servers',
  integrations: '#/integrations',
  'monitor-performance': '#/monitor/performance',
  'mcp-roles': '#/mcp-roles',
  'settings-roles': '#/settings/roles',
  'settings-databases': '#/settings/databases',
  'settings-tools': '#/settings/tools',
  'settings-execution': '#/settings/execution',
};

const DEFAULT: RouteKey = 'projects';

function parseHash(): RouteKey {
  const [section, sub] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (section === 'tasks') {
    if (sub === 'review') return 'tasks-review';
    if (sub === 'done') return 'tasks-done';
    return 'tasks';
  }
  if (section === 'departments' && sub === 'development') return 'departments-development';
  // Обратная совместимость: старый #/scheme (и его вариации) ведёт на тот же раздел.
  if (section === 'scheme' || section === 'development-scheme') return 'departments-development';
  if (section === 'servers') return 'servers';
  if (section === 'integrations') return 'integrations';
  if (section === 'monitor') return 'monitor-performance';
  if (section === 'mcp-roles') return 'mcp-roles';
  if (section === 'settings') {
    if (sub === 'databases') return 'settings-databases';
    if (sub === 'tools') return 'settings-tools';
    if (sub === 'execution') return 'settings-execution';
    return 'settings-roles';
  }
  return 'projects';
}

interface RouterValue {
  route: RouteKey;
  navigate: (to: RouteKey) => void;
  href: (to: RouteKey) => string;
}

const RouterContext = createContext<RouterValue | null>(null);

/** Минималистичный hash-роутер без внешних зависимостей (поддерживает URL-навигацию). */
export function RouterProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<RouteKey>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    // нормализуем пустой hash
    if (!window.location.hash) window.location.replace(ROUTES[DEFAULT]);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const navigate = useCallback((to: RouteKey) => {
    if (window.location.hash !== ROUTES[to]) window.location.hash = ROUTES[to];
    setRoute(to);
  }, []);

  const href = useCallback((to: RouteKey) => ROUTES[to], []);

  return (
    <RouterContext.Provider value={{ route, navigate, href }}>
      {children}
    </RouterContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useRouter(): RouterValue {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error('useRouter должен использоваться внутри RouterProvider');
  return ctx;
}
