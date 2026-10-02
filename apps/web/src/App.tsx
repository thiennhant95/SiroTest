import { Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider as UiToastProvider } from "./components/ui";
import { ToastProvider as LegacyToastProvider } from "./components/Toast";
import { getToken } from "./lib/api";
import { ActionsPage } from "./pages/ActionsPage";
import { BuilderPage } from "./pages/BuilderPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectDetailPage } from "./pages/ProjectDetailPage";
import { ProjectTestsPage } from "./pages/ProjectTestsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecordPage } from "./pages/RecordPage";
import { RunDetailRoute } from "./pages/RunDetailPage";
import { RunPage } from "./pages/RunPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SuiteDetailPage } from "./pages/SuiteDetailPage";
import { SuiteRunDetailPage } from "./pages/SuiteRunDetailPage";
import { SuitesPage } from "./pages/SuitesPage";

function RequireAuth({ children }: { children: JSX.Element }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <UiToastProvider>
      <LegacyToastProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/projects" element={<RequireAuth><ProjectsPage /></RequireAuth>} />
          <Route path="/projects/:id" element={<RequireAuth><ProjectDetailPage /></RequireAuth>} />
          <Route path="/projects/:id/tests" element={<RequireAuth><ProjectTestsPage /></RequireAuth>} />
          <Route path="/projects/:id/actions" element={<RequireAuth><ActionsPage /></RequireAuth>} />
          <Route path="/projects/:id/suites" element={<RequireAuth><SuitesPage /></RequireAuth>} />
          <Route path="/suites/:sid" element={<RequireAuth><SuiteDetailPage /></RequireAuth>} />
          <Route path="/suite-runs/:suiteRunId" element={<RequireAuth><SuiteRunDetailPage /></RequireAuth>} />
          <Route path="/tests/:id" element={<RequireAuth><BuilderPage /></RequireAuth>} />
          <Route path="/tests/:id/record" element={<RequireAuth><RecordPage /></RequireAuth>} />
          <Route path="/runs/:id" element={<RequireAuth><RunDetailRoute /></RequireAuth>} />
          {/* Live-only fallback view (WS timeline + cancel); main view is RunDetailRoute. */}
          <Route path="/runs/:id/live" element={<RequireAuth><RunPage /></RequireAuth>} />
          <Route path="/settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </LegacyToastProvider>
    </UiToastProvider>
  );
}
