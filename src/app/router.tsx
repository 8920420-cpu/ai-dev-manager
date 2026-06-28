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
  | 'development-scheme'
  | 'integrations'
  | 'monitor-performance'
  | 'settings-roles'
  | 'settings-tools'
  | 'settings-execution';

const ROUTES: Record<RouteKey, string> = {
  projects: '#/projects',
  tasks: '#/tasks',
  'development-scheme': '#/scheme',
  integrations: '#/integrations',
  'monitor-performance': '#/monitor/performance',
  'settings-roles': '#/settings/roles',
  'settings-tools': '#/settings/tools',
  'settings-execution': '#/settings/execution',
};

const DEFAULT: RouteKey = 'projects';

function parseHash(): RouteKey {
  const [section, sub] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (section === 'tasks') return 'tasks';
  if (section === 'scheme') return 'development-scheme';
  if (section === 'integrations') return 'integrations';
  if (section === 'monitor') return 'monitor-performance';
  if (section === 'settings') {
    // Раздел «Базы данных» удалён: БД одна (БД оркестратора).
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
