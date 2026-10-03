import { Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider } from "./components/ui";
import { getToken } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { ActionsPage } from "./pages/ActionsPage";
import { BuilderPage } from "./pages/BuilderPage";
import { FilesPage } from "./pages/FilesPage";
import { LoginPage } from "./pages/LoginPage";
import { ProfilesPage } from "./pages/ProfilesPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectTestsPage } from "./pages/ProjectTestsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecordPage } from "./pages/RecordPage";
import { SchedulesPage } from "./pages/SchedulesPage";
import { RunDetailRoute } from "./pages/RunDetailPage";
import { RunPage } from "./pages/RunPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SuiteDetailPage } from "./pages/SuiteDetailPage";
import { SuiteRunDetailPage } from "./pages/SuiteRunDetailPage";
import { SuitesPage } from "./pages/SuitesPage";
import { HealingPage } from "./pages/HealingPage";
import { AiAssistantPage } from "./pages/AiAssistantPage";
import { VisualPage } from "./pages/VisualPage";
import { PluginDocs } from "./components/PluginDocs";
import { AnalyticsPage } from "./pages/AnalyticsPage";
import { AuditPage } from "./pages/AuditPage";
import { WorkersPage } from "./pages/WorkersPage";

function RequireAuth({ children }: { children: JSX.Element }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

function Shell() {
  return (
    <RequireAuth>
      <AppShell />
    </RequireAuth>
  );
}

export function App() {
  return (
    <ToastProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<Shell />}>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectDetailPage />} />
          <Route path="/projects/:id/tests" element={<ProjectTestsPage />} />
          <Route path="/projects/:id/actions" element={<ActionsPage />} />
          <Route path="/projects/:id/profiles" element={<ProfilesPage />} />
          <Route path="/projects/:id/files" element={<FilesPage />} />
          <Route path="/projects/:id/schedules" element={<SchedulesPage />} />
          <Route path="/projects/:id/suites" element={<SuitesPage />} />
          <Route path="/suites/:sid" element={<SuiteDetailPage />} />
          <Route path="/suite-runs/:suiteRunId" element={<SuiteRunDetailPage />} />
          <Route path="/tests/:id" element={<BuilderPage />} />
          <Route path="/tests/:id/record" element={<RecordPage />} />
          <Route path="/tests/:id/healing" element={<HealingPage />} />
          <Route path="/tests/:id/visual" element={<VisualPage />} />
          <Route path="/projects/:id/ai" element={<AiAssistantPage />} />
          <Route path="/projects/:id/analytics" element={<AnalyticsPage />} />
          <Route path="/projects/:id/audit" element={<AuditPage />} />
          <Route path="/workers" element={<WorkersPage />} />
          <Route path="/plugins" element={<PluginDocs />} />
          <Route path="/runs/:id" element={<RunDetailRoute />} />
          {/* Live-only fallback view (WS timeline + cancel); main view is RunDetailRoute. */}
          <Route path="/runs/:id/live" element={<RunPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Routes>
    </ToastProvider>
  );
}
