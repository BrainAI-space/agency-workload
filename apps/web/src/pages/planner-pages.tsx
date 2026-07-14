import { addWeeks, format, startOfWeek } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarRange,
  CircleHelp,
  LogOut,
  Palmtree,
  Search,
  Settings,
  UserRound,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth-context";

const legend = [
  ["Confirmed", "legend-confirmed"],
  ["Tentative", "legend-tentative"],
  ["Available", "legend-available"],
  ["Leave", "legend-leave"],
] as const;

export function SchedulePage() {
  const [weekOffset, setWeekOffset] = useState(0);
  const [zoom, setZoom] = useState("4 weeks");
  const week = addWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), weekOffset);
  const weeks = Array.from({ length: zoom === "8 weeks" ? 8 : 4 }, (_, index) =>
    addWeeks(week, index),
  );

  return (
    <section className="planner-page" aria-labelledby="schedule-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Planning board / Current edition</p>
          <h1 id="schedule-title">Schedule</h1>
        </div>
        <div className="schedule-actions">
          <button
            className="primary-button"
            type="button"
            disabled
            title="Capacity search arrives with the planning domain milestone."
          >
            <Search aria-hidden="true" /> Find capacity
          </button>
        </div>
      </header>

      <p className="edition-line">
        <span>Edition 01</span> The planning surface is ready; people, projects, allocation, leave,
        and capacity APIs arrive in the next domain milestone.
      </p>

      <div className="planner-toolbar" role="toolbar" aria-label="Schedule controls">
        <div className="date-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous week"
            onClick={() => setWeekOffset((value) => value - 1)}
          >
            <ArrowLeft aria-hidden="true" />
          </button>
          <button
            type="button"
            className="secondary-button compact"
            onClick={() => setWeekOffset(0)}
          >
            Today
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Next week"
            onClick={() => setWeekOffset((value) => value + 1)}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <span className="date-range">
            <CalendarRange aria-hidden="true" /> Week of {format(week, "d MMM yyyy")}
          </span>
        </div>
        <label className="zoom-control">
          Zoom
          <select value={zoom} onChange={(event) => setZoom(event.target.value)}>
            <option>4 weeks</option>
            <option>8 weeks</option>
          </select>
        </label>
      </div>

      <section className="desktop-board" aria-label="Desktop planning board">
        <table className="schedule-table" aria-label="People by week">
          <thead>
            <tr>
              <th scope="col">Person / capacity</th>
              {weeks.map((date) => (
                <th scope="col" key={date.toISOString()}>
                  <span>{format(date, "MMM")}</span>
                  {format(date, "d")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={weeks.length + 1}>
                <div className="board-empty">
                  <CircleHelp aria-hidden="true" />
                  <div>
                    <strong>No planning records yet</strong>
                    <p>
                      People and allocations will appear here after the planning domain is
                      connected.
                    </p>
                  </div>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mobile-brief" aria-label="Weekly brief">
        <p className="eyebrow">Mobile weekly brief</p>
        <h2>{format(week, "d MMM")} — operating view</h2>
        <dl>
          <div>
            <dt>People scheduled</dt>
            <dd>Not available yet</dd>
          </div>
          <div>
            <dt>Capacity conflicts</dt>
            <dd>Not available yet</dd>
          </div>
          <div>
            <dt>Leave recorded</dt>
            <dd>Not available yet</dd>
          </div>
        </dl>
        <p>
          This view will summarize real planning data instead of compressing the desktop timeline.
        </p>
      </section>

      <footer className="planner-footer">
        <ul className="capacity-legend" aria-label="Capacity legend">
          {legend.map(([label, className]) => (
            <li key={label}>
              <span className={className} aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
        <p>Capacity search arrives with the planning domain milestone.</p>
      </footer>
    </section>
  );
}

const placeholderCopy = {
  forecast: [
    "Forecast",
    "Advisory utilization will appear here after capacity and allocation rules are implemented.",
  ],
  projects: [
    "Projects",
    "Project records and confirmed or tentative allocation controls are part of the next milestone.",
  ],
  people: [
    "People",
    "Schedulable people remain separate from login accounts. The people directory is not connected yet.",
  ],
  leave: [
    "Leave",
    "Leave and holiday capacity adjustments will be visible without rewriting allocations.",
  ],
} as const;

export function PlaceholderPage({ kind }: { kind: keyof typeof placeholderCopy }) {
  const [title, description] = placeholderCopy[kind];
  return (
    <section className="placeholder-page" aria-labelledby={`${kind}-title`}>
      <p className="eyebrow">Planned surface</p>
      <h1 id={`${kind}-title`}>{title}</h1>
      <p>{description}</p>
      <div className="milestone-note">
        <span>Next domain milestone</span>
        <p>No production records are seeded or simulated on this page.</p>
      </div>
    </section>
  );
}

export function MorePage() {
  const { user, logout } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === "owner" || user?.role === "admin";
  const handleLogout = async () => {
    setBusy(true);
    setError(null);
    try {
      await logout();
    } catch {
      setError("Could not log out. Your session is still active.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="more-page" aria-labelledby="more-title">
      <p className="eyebrow">Mobile fallback / account</p>
      <h1 id="more-title">More</h1>
      <p>
        Secondary planning and account destinations, kept together without inventing unfinished
        controls.
      </p>
      <nav className="more-links" aria-label="More destinations">
        <Link to="/leave">
          <Palmtree aria-hidden="true" />
          <span>
            <strong>Leave</strong>
            <small>Capacity-reducing time away</small>
          </span>
          <ArrowRight aria-hidden="true" />
        </Link>
        {isAdmin ? (
          <Link to="/admin/members">
            <Settings aria-hidden="true" />
            <span>
              <strong>Administration</strong>
              <small>Members, invitations, and audit</small>
            </span>
            <ArrowRight aria-hidden="true" />
          </Link>
        ) : null}
      </nav>
      <div className="account-summary">
        <UserRound aria-hidden="true" />
        <div>
          <span className="eyebrow">Current account</span>
          <strong>{user?.role ?? "member"}</strong>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void handleLogout()}
          disabled={busy}
        >
          <LogOut aria-hidden="true" />
          {busy ? "Logging out..." : "Log out"}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
