import { useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import client from "./api/client";
import { useAuthStore } from "./store/auth";
import { useDesktopStore } from "./store/desktop";
import AppShell from "./components/layout/AppShell";
import Login from "./pages/Login";
import Desktop from "./pages/Desktop";

// Secondary routes are code-split so the login/desktop bundle stays small.
const Profile = lazy(() => import("./pages/Profile"));
const Storage = lazy(() => import("./pages/Storage"));
const AdminDashboard = lazy(() => import("./pages/admin/Dashboard"));
const AdminUsers = lazy(() => import("./pages/admin/Users"));
const AdminGroups = lazy(() => import("./pages/admin/Groups"));
const AdminApps = lazy(() => import("./pages/admin/Apps"));
const AdminSessions = lazy(() => import("./pages/admin/Sessions"));
const AdminTraffic = lazy(() => import("./pages/admin/Traffic"));
const AdminSettings = lazy(() => import("./pages/admin/Settings"));
const AuditLog = lazy(() => import("./pages/admin/AuditLog"));
const Analytics = lazy(() => import("./pages/admin/Analytics"));
const SharedViewer = lazy(() => import("./pages/SharedViewer"));

function Spinner() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-950">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-indigo-500 border-t-transparent" />
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuthStore();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!user) {
    // Preserve deep links (e.g. "?open=" from Nextcloud's "Open in Nextdesk")
    // across the login round trip.
    const target = location.pathname + location.search;
    const to = target === "/" ? "/login" : `/login?next=${encodeURIComponent(target)}`;
    return <Navigate to={to} replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { user } = useAuthStore();
  if (!user?.is_admin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  const { setUser, setLoading } = useAuthStore();
  const loadFromServer = useDesktopStore((s) => s.loadFromServer);

  useEffect(() => {
    client
      .get("/api/auth/me")
      .then((r) => {
        setUser(r.data);
        setLoading(false);
        if (r.data.preferences) loadFromServer(r.data.preferences);
      })
      .catch(() => { setUser(null); setLoading(false); });
  }, [setUser, setLoading, loadFromServer]);

  return (
    <BrowserRouter>
      <Suspense fallback={<Spinner />}>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Main desktop — full-screen, no shell/sidebar */}
        <Route
          path="/"
          element={<RequireAuth><Desktop /></RequireAuth>}
        />

        {/* Shared-session guest viewer — full-screen, login required */}
        <Route
          path="/shared/:token"
          element={<RequireAuth><SharedViewer /></RequireAuth>}
        />

        {/* Admin area — uses sidebar AppShell */}
        <Route path="/admin" element={<RequireAuth><RequireAdmin><AppShell /></RequireAdmin></RequireAuth>}>
          <Route index element={<AdminDashboard />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="groups" element={<AdminGroups />} />
          <Route path="apps" element={<AdminApps />} />
          <Route path="sessions" element={<AdminSessions />} />
          <Route path="traffic" element={<AdminTraffic />} />
          <Route path="audit" element={<AuditLog />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="settings" element={<AdminSettings />} />
        </Route>

        {/* User preference pages (still in AppShell for now) */}
        <Route path="/profile" element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Profile />} />
        </Route>
        <Route path="/storage" element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Storage />} />
        </Route>
      </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
