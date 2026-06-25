import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './components/ui';
import { RouterProvider, useRouter } from './app/router';
import { AppShell } from './components/layout/AppShell';
import { ConnectedProjectsPage } from './features/projects/ConnectedProjectsPage';
import { DevelopmentSchemePage } from './features/scheme/DevelopmentSchemePage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { RolesPage } from './features/settings/RolesPage';
import { ToolsPage } from './features/settings/ToolsPage';

function CurrentPage() {
  const { route } = useRouter();
  switch (route) {
    case 'development-scheme':
      return <DevelopmentSchemePage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'settings-roles':
      return <RolesPage />;
    case 'settings-tools':
      return <ToolsPage />;
    case 'projects':
    default:
      return <ConnectedProjectsPage />;
  }
}

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <RouterProvider>
          <AppShell>
            <CurrentPage />
          </AppShell>
        </RouterProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
