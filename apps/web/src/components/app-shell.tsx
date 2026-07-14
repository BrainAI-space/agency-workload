import {
  CalendarDays,
  ChartNoAxesCombined,
  FolderKanban,
  LogOut,
  Menu,
  Palmtree,
  Settings,
  Users,
} from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth/auth-context";

const primaryLinks = [
  { to: "/schedule", label: "Schedule", icon: CalendarDays },
  { to: "/forecast", label: "Forecast", icon: ChartNoAxesCombined },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/people", label: "People", icon: Users },
  { to: "/leave", label: "Leave", icon: Palmtree },
];

const mobileLinks = [
  { to: "/schedule", label: "Plan", icon: CalendarDays },
  { to: "/forecast", label: "Forecast", icon: ChartNoAxesCombined },
  { to: "/projects", label: "Projects", icon: FolderKanban },
  { to: "/people", label: "People", icon: Users },
  { to: "/more", label: "More", icon: Menu },
];

export function AppShell() {
  const { user, logout } = useAuth();
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const handleLogout = async () => {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch {
      setLogoutError("Could not log out. Your session is still active.");
    } finally {
      setLoggingOut(false);
    }
  };
  return (
    <div className="app-frame">
      <header className="masthead">
        <NavLink className="wordmark" to="/schedule" aria-label="Agency Workload schedule">
          <span className="wordmark-index">AW</span>
          <span>Agency Workload</span>
        </NavLink>
        <nav className="desktop-nav" aria-label="Primary navigation">
          {primaryLinks.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="account-actions">
          {isAdmin ? (
            <NavLink className="admin-link" to="/admin/members">
              <Settings aria-hidden="true" /> Admin
            </NavLink>
          ) : null}
          <span className="role-stamp">{user?.role ?? "member"}</span>
          {logoutError ? (
            <p className="logout-error" role="alert">
              {logoutError}
            </p>
          ) : null}
          <button
            className="icon-button"
            type="button"
            onClick={() => void handleLogout()}
            aria-label="Log out"
            disabled={loggingOut}
          >
            <LogOut aria-hidden="true" />
          </button>
        </div>
      </header>
      <main className="workspace" id="main-content">
        <Outlet />
      </main>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {mobileLinks.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : undefined)}>
            <Icon aria-hidden="true" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

const adminLinks = [
  ["/admin/members", "Members"],
  ["/admin/invitations", "Invitations"],
  ["/admin/audit", "Audit"],
  ["/admin/settings", "Settings"],
] as const;

export function AdminLayout() {
  return (
    <section className="admin-workspace" aria-labelledby="admin-title">
      <header className="admin-heading">
        <div>
          <p className="eyebrow">Organization desk</p>
          <h1 id="admin-title">Administration</h1>
        </div>
        <nav className="section-tabs" aria-label="Administration sections">
          {adminLinks.map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => (isActive ? "active" : undefined)}
            >
              {label}
            </NavLink>
          ))}
        </nav>
      </header>
      <Outlet />
    </section>
  );
}
