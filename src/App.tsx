import { ThemeProvider } from './theme/ThemeProvider';
import { ToastProvider } from './components/ui';
import { RouterProvider, useRouter } from './app/router';
import { AppShell } from './components/layout/AppShell';
import { ConnectedProjectsPage } from './features/projects/ConnectedProjectsPage';
import { TasksPage } from './features/tasks/TasksPage';
import { AcceptanceBoardPage } from './features/tasks/AcceptanceBoardPage';
import { DevelopmentSchemePage } from './features/scheme/DevelopmentSchemePage';
import { ServersPage } from './features/servers/ServersPage';
import { IntegrationsPage } from './features/integrations/IntegrationsPage';
import { PerformanceMonitorPage } from './features/monitor/PerformanceMonitorPage';
import { McpRolesPage } from './features/settings/McpRolesPage';
import { RolesPage } from './features/settings/RolesPage';
import { ToolsPage } from './features/settings/ToolsPage';
import { ExecutionPage } from './features/settings/ExecutionPage';

function CurrentPage() {
  const { route } = useRouter();
  switch (route) {
    case 'tasks':
      return <TasksPage />;
    case 'tasks-review':
      return <AcceptanceBoardPage mode="review" />;
    case 'tasks-done':
      return <AcceptanceBoardPage mode="done" />;
    case 'departments-development':
      return <DevelopmentSchemePage />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'monitor-performance':
      return <PerformanceMonitorPage />;
    case 'mcp-roles':
      return <McpRolesPage />;
    case 'servers':
      return <ServersPage />;
    case 'settings-roles':
      return <RolesPage />;
    case 'settings-tools':
      return <ToolsPage />;
    case 'settings-execution':
      return <ExecutionPage />;
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
