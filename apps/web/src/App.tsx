import { Navigate, Route, Routes } from "react-router-dom";
import { ToastProvider as UiToastProvider } from "./components/ui";
import { ToastProvider as LegacyToastProvider } from "./components/Toast";
import { getToken } from "./lib/api";
import { BuilderPage } from "./pages/BuilderPage";
import { LoginPage } from "./pages/LoginPage";
import { ProjectTestsPage } from "./pages/ProjectTestsPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { RecordPage } from "./pages/RecordPage";
import { RunDetailRoute } from "./pages/RunDetailPage";

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
          <Route path="/projects/:id" element={<Navigate to="./tests" replace />} />
          <Route path="/projects/:id/tests" element={<RequireAuth><ProjectTestsPage /></RequireAuth>} />
          <Route path="/tests/:id" element={<RequireAuth><BuilderPage /></RequireAuth>} />
          <Route path="/tests/:id/record" element={<RequireAuth><RecordPage /></RequireAuth>} />
          <Route path="/runs/:id" element={<RequireAuth><RunDetailRoute /></RequireAuth>} />
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </LegacyToastProvider>
    </UiToastProvider>
  );
}
