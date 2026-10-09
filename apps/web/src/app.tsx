import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/app-shell';
import { ChatScopeProvider } from './contexts/chat-scope-context';
import { ToastViewport } from './components/toast';
import { AuthProvider, useAuth } from './contexts/auth-context';
import { HubProvider, useHub } from './contexts/hub-context';
import { ThemeProvider } from './contexts/theme-context';
import { removeBootCover } from './lib/boot-cover';
import { AuthPage } from './pages/auth-page';

const DashboardPage = lazy(() => import('./pages/dashboard-page').then(m => ({ default: m.DashboardPage })));
const ExecutionPage = lazy(() => import('./pages/execution-page').then(m => ({ default: m.ExecutionPage })));
const HistoryPage = lazy(() => import('./pages/history-page').then(m => ({ default: m.HistoryPage })));
const NotificationsPage = lazy(() => import('./pages/notifications-page').then(m => ({ default: m.NotificationsPage })));
const AutomationRequestsPage = lazy(() => import('./pages/automation-requests-page').then(m => ({ default: m.AutomationRequestsPage })));
const DashboardRequestPage = lazy(() => import('./pages/dashboard-request-page').then(m => ({ default: m.DashboardRequestPage })));
const ResultsPage = lazy(() => import('./pages/results-page').then(m => ({ default: m.ResultsPage })));
const RobotDetailPage = lazy(() => import('./pages/robot-detail-page').then(m => ({ default: m.RobotDetailPage })));
const RobotsPage = lazy(() => import('./pages/robots-page').then(m => ({ default: m.RobotsPage })));
const SchedulesPage = lazy(() => import('./pages/schedules-page').then(m => ({ default: m.SchedulesPage })));
const DevDocsPage = lazy(() => import('./pages/dev-docs-page').then(m => ({ default: m.DevDocsPage })));
const SettingsPage = lazy(() => import('./pages/settings-page').then(m => ({ default: m.SettingsPage })));
const SitesPage = lazy(() => import('./pages/sites-page').then(m => ({ default: m.SitesPage })));
const TimeSavingsPage = lazy(() => import('./pages/time-savings-page').then(m => ({ default: m.TimeSavingsPage })));
const ProfilePage = lazy(() => import('./pages/profile-page').then(m => ({ default: m.ProfilePage })));

export function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <HubProvider>
          <BrowserRouter>
            <AppRoutes />
            <ToastViewport />
          </BrowserRouter>
        </HubProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

function AppRoutes() {
  const { user, bootstrapping } = useAuth();
  const { refreshHub } = useHub();
  const canViewBoard = user?.role === 'admin' || user?.departments.includes('inovacao') === true;

  useEffect(() => {
    if (user) {
      void refreshHub();
    }
  }, [refreshHub, user]);

  // Sem sessão: vai pra tela de login, então a cobertura de painel não faz mais sentido.
  useEffect(() => {
    if (!bootstrapping && !user) removeBootCover();
  }, [bootstrapping, user]);

  if (bootstrapping) {
    return <div className="grid grid-cols-1 min-h-screen place-items-center text-sm text-slate-500">Carregando sessão...</div>;
  }

  if (!user) {
    return <AuthPage />;
  }

  return (
    <Routes>
      <Route element={<ChatScopeProvider><AppShell /></ChatScopeProvider>}>
        <Route path="/" element={<Suspense fallback={null}><DashboardPage /></Suspense>} />
        <Route path="/robots" element={<Suspense fallback={null}><RobotsPage /></Suspense>} />
        <Route path="/automation-requests" element={<Suspense fallback={null}><AutomationRequestsPage /></Suspense>} />
        <Route path="/dashboard-requests" element={<Suspense fallback={null}><DashboardRequestPage /></Suspense>} />
        <Route
          path="/admin/quadro"
          element={canViewBoard ? <Suspense fallback={null}><AutomationRequestsPage /></Suspense> : <Navigate to="/" replace />}
        />
        <Route path="/sites" element={<Suspense fallback={null}><SitesPage /></Suspense>} />
        <Route path="/dashboards" element={<Navigate to="/sites?tab=paineis" replace />} />
        <Route path="/robots/:id" element={<Suspense fallback={null}><RobotDetailPage /></Suspense>} />
        <Route path="/schedules" element={<Suspense fallback={null}><SchedulesPage /></Suspense>} />
        <Route path="/executions/:id" element={<Suspense fallback={null}><ExecutionPage /></Suspense>} />
        <Route path="/history" element={<Suspense fallback={null}><HistoryPage /></Suspense>} />
        <Route path="/notifications" element={<Suspense fallback={null}><NotificationsPage /></Suspense>} />
        <Route path="/results" element={<Suspense fallback={null}><ResultsPage /></Suspense>} />
        <Route path="/time-savings" element={<Suspense fallback={null}><TimeSavingsPage /></Suspense>} />
        <Route path="/profile" element={<Suspense fallback={null}><ProfilePage /></Suspense>} />
        <Route
          path="/settings"
          element={user.role === 'admin' ? <Suspense fallback={null}><SettingsPage /></Suspense> : <Navigate to="/" replace />}
        />
        <Route
          path="/docs"
          element={user.role === 'admin' ? <Suspense fallback={null}><DevDocsPage /></Suspense> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
