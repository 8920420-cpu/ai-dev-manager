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
  | 'integrations'
  | 'settings-roles'
  | 'settings-databases';

const ROUTES: Record<RouteKey, string> = {
  projects: '#/projects',
  integrations: '#/integrations',
  'settings-roles': '#/settings/roles',
  'settings-databases': '#/settings/databases',
};

const DEFAULT: RouteKey = 'projects';

function parseHash(): RouteKey {
  const [section, sub] = window.location.hash.replace(/^#\/?/, '').split('/');
  if (section === 'integrations') return 'integrations';
  if (section === 'settings') {
    // Legacy '#/settings' и любой неизвестный подраздел → «Роли».
    return sub === 'databases' ? 'settings-databases' : 'settings-roles';
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
