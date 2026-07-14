import { createBrowserRouter, createMemoryRouter, Navigate, Outlet } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/auth-context";
import { AdminLayout, AppShell } from "./components/app-shell";
import {
  ForbiddenPage,
  LoadingState,
  NotFoundPage,
  RouteErrorPage,
} from "./components/route-states";
import { AdminSettingsPage, AuditPage, InvitationsPage, MembersPage } from "./pages/admin-pages";
import { LoginPage, VerifyPage } from "./pages/auth-pages";
import {
  ForecastPage,
  MorePage,
  PeoplePage,
  PlaceholderPage,
  ProjectsPage,
  SchedulePage,
} from "./pages/planner-pages";

function Root() {
  return (
    <AuthProvider>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <Outlet />
    </AuthProvider>
  );
}

function ProtectedRoutes() {
  const { status } = useAuth();
  if (status === "loading") return <LoadingState />;
  if (status === "unauthenticated") return <Navigate to="/login" replace />;
  return <Outlet />;
}

function AdminGuard() {
  const { user } = useAuth();
  if (user?.role !== "owner" && user?.role !== "admin") return <ForbiddenPage />;
  return <Outlet />;
}

const routes = [
  {
    element: <Root />,
    errorElement: <RouteErrorPage />,
    children: [
      { path: "/login", element: <LoginPage /> },
      { path: "/verify", element: <VerifyPage /> },
      {
        element: <ProtectedRoutes />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, element: <Navigate to="/schedule" replace /> },
              { path: "/schedule", element: <SchedulePage /> },
              { path: "/forecast", element: <ForecastPage /> },
              { path: "/projects", element: <ProjectsPage /> },
              { path: "/people", element: <PeoplePage /> },
              { path: "/leave", element: <PlaceholderPage kind="leave" /> },
              { path: "/more", element: <MorePage /> },
              {
                element: <AdminGuard />,
                children: [
                  {
                    element: <AdminLayout />,
                    children: [
                      { path: "/admin/members", element: <MembersPage /> },
                      { path: "/admin/invitations", element: <InvitationsPage /> },
                      { path: "/admin/audit", element: <AuditPage /> },
                      { path: "/admin/settings", element: <AdminSettingsPage /> },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
];

export const appRouter = createBrowserRouter(routes);
export const createMemoryAppRouter = (initialEntries: string[]) =>
  createMemoryRouter(routes, { initialEntries });
