import { addWeeks, endOfWeek, format, isWithinInterval, parseISO, startOfWeek } from "date-fns";
import {
  ArrowLeft,
  ArrowRight,
  CalendarRange,
  CircleHelp,
  FolderPlus,
  LogOut,
  Palmtree,
  Plus,
  Search,
  Settings,
  UserPlus,
  UserRound,
} from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth-context";
import {
  type Allocation,
  ApiError,
  type EarliestStartResult,
  type ForecastResponse,
  type NamedItem,
  type Person,
  type Project,
  type Scenario,
  type ScheduleResponse,
  api,
} from "../lib/api";

const legend = [
  ["Confirmed", "legend-confirmed"],
  ["Tentative", "legend-tentative"],
  ["Available", "legend-available"],
  ["Unavailable", "legend-leave"],
] as const;
const managers = new Set(["owner", "admin", "planner"]);

function isoDate(date: Date) {
  return format(date, "yyyy-MM-dd");
}

function hours(minutes: number) {
  const value = minutes / 60;
  return Number.isInteger(value) ? `${value}h` : `${value.toFixed(1)}h`;
}

function friendlyError(error: unknown, fallback: string) {
  if (!(error instanceof ApiError)) return fallback;
  const messages: Record<string, string> = {
    stale_write:
      "Someone changed this record. Refresh and try again; your entered values remain here.",
    future_allocations_exist: "Resolve current or future allocations before archiving this record.",
    project_not_allocatable: "Completed, cancelled, or archived projects cannot receive work.",
    invalid_date_range: "The end date must be on or after the start date.",
    forbidden: "Your role cannot perform that action.",
  };
  return messages[error.code] ?? fallback;
}

export function SchedulePage() {
  const { user, csrfToken } = useAuth();
  const canManage = managers.has(user?.role ?? "viewer");
  const [weekOffset, setWeekOffset] = useState(0);
  const [zoom, setZoom] = useState<4 | 8>(4);
  const [scenario, setScenario] = useState<Scenario>("confirmed_and_tentative");
  const week = addWeeks(startOfWeek(new Date(), { weekStartsOn: 1 }), weekOffset);
  const weeks = useMemo(
    () => Array.from({ length: zoom }, (_, index) => addWeeks(week, index)),
    [week, zoom],
  );
  const start = isoDate(week);
  const end = isoDate(endOfWeek(weeks.at(-1) ?? week, { weekStartsOn: 1 }));
  const [people, setPeople] = useState<Person[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showAllocation, setShowAllocation] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);

  useEffect(() => {
    void reload;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void Promise.all([
      api.listPeople(controller.signal),
      api.listProjects(controller.signal),
      api.listAllocations(start, end, controller.signal),
      api.getSchedule(start, end, scenario, controller.signal),
    ])
      .then(([nextPeople, nextProjects, nextAllocations, nextSchedule]) => {
        setPeople(nextPeople);
        setProjects(nextProjects);
        setAllocations(nextAllocations);
        setSchedule(nextSchedule);
      })
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") {
          setError(friendlyError(loadError, "The planning board could not be loaded."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [start, end, scenario, reload]);

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const conflictCount = schedule?.conflicts.length ?? 0;
  const scheduledPeople = schedule?.people.filter((entry) =>
    entry.days.some((day) => day.confirmedMinutes + day.tentativeMinutes > 0),
  ).length;
  const totalAvailable =
    schedule?.people.reduce(
      (sum, entry) =>
        sum +
        entry.days.reduce(
          (daySum, day) =>
            daySum +
            (scenario === "confirmed"
              ? day.availableConfirmedMinutes
              : day.availableScenarioMinutes),
          0,
        ),
      0,
    ) ?? 0;

  return (
    <section className="planner-page" aria-labelledby="schedule-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Planning board / live data</p>
          <h1 id="schedule-title">Schedule</h1>
        </div>
        <div className="schedule-actions">
          {canManage ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => setShowAllocation(true)}
            >
              <Plus aria-hidden="true" /> Plan work
            </button>
          ) : null}
          <button className="primary-button" type="button" onClick={() => setFinderOpen(true)}>
            <Search aria-hidden="true" /> Find capacity
          </button>
        </div>
      </header>

      <p className="edition-line">
        <span>Live edition</span> {scheduledPeople ?? 0} people scheduled · {conflictCount}{" "}
        conflicts · {hours(totalAvailable)} available across this view
      </p>

      <div className="planner-toolbar" role="toolbar" aria-label="Schedule controls">
        <div className="date-controls">
          <button
            type="button"
            className="icon-button"
            aria-label="Previous period"
            onClick={() => setWeekOffset((value) => value - zoom)}
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
            aria-label="Next period"
            onClick={() => setWeekOffset((value) => value + zoom)}
          >
            <ArrowRight aria-hidden="true" />
          </button>
          <span className="date-range">
            <CalendarRange aria-hidden="true" /> {format(week, "d MMM")} –{" "}
            {format(parseISO(end), "d MMM yyyy")}
          </span>
        </div>
        <div className="view-controls">
          <label>
            Scenario
            <select
              value={scenario}
              onChange={(event) => setScenario(event.target.value as Scenario)}
            >
              <option value="confirmed">Confirmed only</option>
              <option value="confirmed_and_tentative">Confirmed + tentative</option>
            </select>
          </label>
          <label>
            Zoom
            <select value={zoom} onChange={(event) => setZoom(Number(event.target.value) as 4 | 8)}>
              <option value={4}>4 weeks</option>
              <option value={8}>8 weeks</option>
            </select>
          </label>
        </div>
      </div>

      {error ? (
        <p className="form-error" role="alert">
          {error}{" "}
          <button
            type="button"
            className="text-button"
            onClick={() => setReload((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : null}
      {loading ? (
        <p className="table-status" aria-live="polite">
          Updating schedule…
        </p>
      ) : null}

      <section className="desktop-board" aria-label="Desktop planning board" aria-busy={loading}>
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
            {people.length === 0 && !loading ? (
              <tr>
                <td colSpan={weeks.length + 1}>
                  <div className="board-empty">
                    <CircleHelp aria-hidden="true" />
                    <div>
                      <strong>No people yet</strong>
                      <p>
                        {canManage
                          ? "Add your first person from the People page, then return to plan work."
                          : "An administrator has not added planning records yet."}
                      </p>
                      {canManage ? (
                        <Link className="text-link" to="/people">
                          Add a person <ArrowRight aria-hidden="true" />
                        </Link>
                      ) : null}
                    </div>
                  </div>
                </td>
              </tr>
            ) : (
              people.map((person) => {
                const personSchedule = schedule?.people.find(
                  (entry) => entry.personId === person.id,
                );
                return (
                  <tr key={person.id}>
                    <th scope="row" className="person-cell">
                      <strong>{person.name}</strong>
                      <small>{person.deliveryRoleId ? "Assigned role" : "No role"}</small>
                    </th>
                    {weeks.map((weekStart) => {
                      const weekEnd = endOfWeek(weekStart, { weekStartsOn: 1 });
                      const days =
                        personSchedule?.days.filter((day) =>
                          isWithinInterval(parseISO(day.date), { start: weekStart, end: weekEnd }),
                        ) ?? [];
                      const capacity = days.reduce((sum, day) => sum + day.capacityMinutes, 0);
                      const booked = days.reduce(
                        (sum, day) =>
                          sum +
                          day.confirmedMinutes +
                          (scenario === "confirmed_and_tentative" ? day.tentativeMinutes : 0),
                        0,
                      );
                      const over = days.reduce(
                        (sum, day) =>
                          sum +
                          (scenario === "confirmed"
                            ? day.confirmedOverbookMinutes
                            : day.potentialOverbookMinutes),
                        0,
                      );
                      const slips = allocations.filter(
                        (allocation) =>
                          allocation.personId === person.id &&
                          allocation.endDate >= isoDate(weekStart) &&
                          allocation.startDate <= isoDate(weekEnd),
                      );
                      return (
                        <td
                          key={weekStart.toISOString()}
                          className={
                            over > 0
                              ? "capacity-week overbooked"
                              : booked === 0
                                ? "capacity-week available"
                                : "capacity-week"
                          }
                        >
                          <span className="capacity-total">
                            {hours(booked)} / {hours(capacity)}
                          </span>
                          {slips.slice(0, 3).map((allocation) => (
                            <button
                              key={allocation.id}
                              type="button"
                              className={`allocation-slip ${allocation.state}`}
                              title={`${projectNames.get(allocation.projectId) ?? "Project"}: ${allocation.state}`}
                              onClick={() => canManage && setShowAllocation(true)}
                            >
                              <span>{projectNames.get(allocation.projectId) ?? "Project"}</span>
                              <small>{allocation.state}</small>
                            </button>
                          ))}
                          {slips.length > 3 ? (
                            <span className="more-count">+{slips.length - 3} more</span>
                          ) : null}
                          {over > 0 ? (
                            <span className="conflict-bracket">+{hours(over)}</span>
                          ) : null}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </section>

      <section className="mobile-brief" aria-label="Weekly brief">
        <p className="eyebrow">Mobile weekly brief</p>
        <h2>{format(week, "d MMM")} — operating view</h2>
        <dl>
          <div>
            <dt>People scheduled</dt>
            <dd>{scheduledPeople ?? 0}</dd>
          </div>
          <div>
            <dt>Capacity conflicts</dt>
            <dd>{conflictCount}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd>{hours(totalAvailable)}</dd>
          </div>
        </dl>
        {people.length === 0 ? (
          <p>No planning records yet.</p>
        ) : (
          <p>Open People or Projects to adjust the plan using accessible forms.</p>
        )}
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
        <p>Forecasts are advisory and based on entered schedules.</p>
      </footer>

      {showAllocation ? (
        <AllocationPanel
          people={people}
          projects={projects}
          csrfToken={csrfToken}
          initialStart={start}
          initialEnd={end}
          onClose={() => setShowAllocation(false)}
          onSaved={() => {
            setShowAllocation(false);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
      {finderOpen ? (
        <StartFinder
          people={people}
          csrfToken={csrfToken}
          onClose={() => setFinderOpen(false)}
          onPlan={() => {
            setFinderOpen(false);
            setShowAllocation(true);
          }}
        />
      ) : null}
    </section>
  );
}

function AllocationPanel({
  people,
  projects,
  csrfToken,
  initialStart,
  initialEnd,
  onClose,
  onSaved,
}: {
  people: Person[];
  projects: Project[];
  csrfToken: string | null;
  initialStart: string;
  initialEnd: string;
  onClose(): void;
  onSaved(): void;
}) {
  const [personId, setPersonId] = useState(people[0]?.id ?? "");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(initialEnd);
  const [minutes, setMinutes] = useState(240);
  const [state, setState] = useState<Allocation["state"]>("confirmed");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken)
      return setError("Session security token is unavailable. Refresh and try again.");
    setBusy(true);
    setError(null);
    try {
      await api.createAllocation(
        {
          personId,
          projectId,
          startDate,
          endDate,
          mode: "minutes_per_day",
          minutesPerDay: minutes,
          state,
        },
        csrfToken,
      );
      onSaved();
    } catch (saveError) {
      setError(friendlyError(saveError, "Could not save this allocation."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        className="side-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="allocation-title"
      >
        <header>
          <div>
            <p className="eyebrow">Plan work</p>
            <h2 id="allocation-title">New allocation</h2>
          </div>
          <button type="button" className="secondary-button compact" onClick={onClose}>
            Close
          </button>
        </header>
        {people.length === 0 || projects.length === 0 ? (
          <p className="form-notice">
            Add at least one person and one active project before planning work.
          </p>
        ) : (
          <form className="stack-form" onSubmit={submit}>
            <label htmlFor="allocation-person">Person</label>
            <select
              id="allocation-person"
              value={personId}
              onChange={(event) => setPersonId(event.target.value)}
              required
            >
              {people.map((person) => (
                <option key={person.id} value={person.id}>
                  {person.name}
                </option>
              ))}
            </select>
            <label htmlFor="allocation-project">Project</label>
            <select
              id="allocation-project"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
              required
            >
              {projects
                .filter((project) => !["completed", "cancelled"].includes(project.status))
                .map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
            </select>
            <div className="form-grid">
              <label>
                Start
                <input
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  required
                />
              </label>
              <label>
                End
                <input
                  type="date"
                  value={endDate}
                  onChange={(event) => setEndDate(event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              Minutes per working day
              <input
                type="number"
                min={1}
                max={1440}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
                required
              />
            </label>
            <label>
              Plan state
              <select
                value={state}
                onChange={(event) => setState(event.target.value as Allocation["state"])}
              >
                <option value="confirmed">Confirmed</option>
                <option value="tentative">Tentative</option>
              </select>
            </label>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Saving…" : "Save allocation"}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

function StartFinder({
  people,
  csrfToken,
  onClose,
  onPlan,
}: {
  people: Person[];
  csrfToken: string | null;
  onClose(): void;
  onPlan(): void;
}) {
  const [notBefore, setNotBefore] = useState(isoDate(new Date()));
  const [dailyMinutes, setDailyMinutes] = useState(240);
  const [workdayCount, setWorkdayCount] = useState(10);
  const [results, setResults] = useState<EarliestStartResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const personNames = new Map(people.map((person) => [person.id, person.name]));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      setResults(
        await api.findEarliestStart(
          {
            notBefore,
            dailyMinutes,
            workdayCount,
            scenario: "confirmed_and_tentative",
            horizonDays: 180,
          },
          csrfToken ?? "",
        ),
      );
    } catch (searchError) {
      setError(friendlyError(searchError, "Could not search availability."));
    }
  };
  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        className="side-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="finder-title"
      >
        <header>
          <div>
            <p className="eyebrow">Start Finder</p>
            <h2 id="finder-title">Who can start?</h2>
          </div>
          <button type="button" className="secondary-button compact" onClick={onClose}>
            Close
          </button>
        </header>
        <form className="stack-form" onSubmit={submit}>
          <label>
            Not before
            <input
              type="date"
              value={notBefore}
              onChange={(event) => setNotBefore(event.target.value)}
            />
          </label>
          <label>
            Minutes per working day
            <input
              type="number"
              min={1}
              max={1440}
              value={dailyMinutes}
              onChange={(event) => setDailyMinutes(Number(event.target.value))}
            />
          </label>
          <label>
            Working days needed
            <input
              type="number"
              min={1}
              max={60}
              value={workdayCount}
              onChange={(event) => setWorkdayCount(Number(event.target.value))}
            />
          </label>
          <button className="primary-button" type="submit">
            Search availability
          </button>
        </form>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="finder-results">
          {results.length === 0 ? (
            <p>No result selected. Searching never assigns work automatically.</p>
          ) : (
            results.map((result) => (
              <article key={result.personId}>
                <strong>{personNames.get(result.personId) ?? "Person"}</strong>
                <p>
                  Available {format(parseISO(result.start), "d MMM")} ·{" "}
                  {hours(result.minimumHeadroomMinutes)} headroom
                </p>
                <small>{result.explanation}</small>
                <button type="button" className="secondary-button compact" onClick={onPlan}>
                  Plan separately
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

export function PeoplePage() {
  const { user, csrfToken } = useAuth();
  const canManage = managers.has(user?.role ?? "viewer");
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<NamedItem[]>([]);
  const [roles, setRoles] = useState<NamedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [activeFrom, setActiveFrom] = useState(isoDate(new Date()));
  const [teamId, setTeamId] = useState("");
  const [roleId, setRoleId] = useState("");
  const load = async () => {
    const [p, t, r] = await Promise.all([
      api.listPeople(),
      api.listTeams(),
      api.listDeliveryRoles(),
    ]);
    setPeople(p);
    setTeams(t);
    setRoles(r);
  };
  useEffect(() => {
    void Promise.all([api.listPeople(), api.listTeams(), api.listDeliveryRoles()])
      .then(([nextPeople, nextTeams, nextRoles]) => {
        setPeople(nextPeople);
        setTeams(nextTeams);
        setRoles(nextRoles);
      })
      .catch((loadError) => setError(friendlyError(loadError, "Could not load people.")));
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    setError(null);
    try {
      await api.createPerson(
        {
          name,
          ...(email ? { email } : {}),
          ...(teamId ? { teamId } : {}),
          ...(roleId ? { deliveryRoleId: roleId } : {}),
          activeFrom,
          schedule: Array.from({ length: 7 }, (_, index) => ({
            isoWeekday: index + 1,
            minutes: index < 5 ? 480 : 0,
          })),
        },
        csrfToken,
      );
      setName("");
      setEmail("");
      await load();
    } catch (saveError) {
      setError(friendlyError(saveError, "Could not add this person."));
    }
  };
  const archive = async (person: Person) => {
    if (!csrfToken || !window.confirm(`Archive ${person.name}?`)) return;
    try {
      await api.archivePerson(person.id, person.rowVersion, csrfToken);
      await load();
    } catch (archiveError) {
      setError(friendlyError(archiveError, "Could not archive this person."));
    }
  };
  return (
    <section className="data-page" aria-labelledby="people-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Planning directory</p>
          <h1 id="people-title">People</h1>
          <p>Schedulable people remain separate from login accounts.</p>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {canManage ? (
        <form className="inline-editor" onSubmit={submit}>
          <h2>Add a person</h2>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Work email (optional)
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <label>
            Active from
            <input
              type="date"
              value={activeFrom}
              onChange={(event) => setActiveFrom(event.target.value)}
              required
            />
          </label>
          <label>
            Team
            <select value={teamId} onChange={(event) => setTeamId(event.target.value)}>
              <option value="">No team</option>
              {teams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Role
            <select value={roleId} onChange={(event) => setRoleId(event.target.value)}>
              <option value="">No role</option>
              {roles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" type="submit">
            <UserPlus aria-hidden="true" /> Add person
          </button>
        </form>
      ) : null}
      <div className="record-list">
        {people.length === 0 ? (
          <p className="table-status">No people yet.</p>
        ) : (
          people.map((person) => (
            <article key={person.id}>
              <div>
                <strong>{person.name}</strong>
                <p>
                  {roles.find((item) => item.id === person.deliveryRoleId)?.name ?? "No role"} ·
                  active from {format(parseISO(person.activeFrom), "d MMM yyyy")}
                </p>
              </div>
              {canManage ? (
                <button
                  className="danger-button"
                  type="button"
                  onClick={() => void archive(person)}
                >
                  Archive
                </button>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function ProjectsPage() {
  const { user, csrfToken } = useAuth();
  const canManage = managers.has(user?.role ?? "viewer");
  const [projects, setProjects] = useState<Project[]>([]);
  const [clients, setClients] = useState<NamedItem[]>([]);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<Project["kind"]>("billable");
  const [status, setStatus] = useState<"draft" | "tentative" | "confirmed">("tentative");
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    const [p, c] = await Promise.all([api.listProjects(), api.listClients()]);
    setProjects(p);
    setClients(c);
  };
  useEffect(() => {
    void Promise.all([api.listProjects(), api.listClients()])
      .then(([nextProjects, nextClients]) => {
        setProjects(nextProjects);
        setClients(nextClients);
      })
      .catch((loadError) => setError(friendlyError(loadError, "Could not load projects.")));
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken) return;
    try {
      await api.createProject({ name, kind, status, ...(clientId ? { clientId } : {}) }, csrfToken);
      setName("");
      await load();
    } catch (saveError) {
      setError(friendlyError(saveError, "Could not add this project."));
    }
  };
  const transition = async (project: Project, action: "archive" | "complete") => {
    if (
      !csrfToken ||
      !window.confirm(`${action === "archive" ? "Archive" : "Complete"} ${project.name}?`)
    )
      return;
    try {
      await api.transitionProject(project.id, action, project.rowVersion, csrfToken);
      await load();
    } catch (actionError) {
      setError(friendlyError(actionError, `Could not ${action} this project.`));
    }
  };
  return (
    <section className="data-page" aria-labelledby="projects-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Delivery plan</p>
          <h1 id="projects-title">Projects</h1>
          <p>Lightweight project demand, not task management.</p>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {canManage ? (
        <form className="inline-editor compact-editor" onSubmit={submit}>
          <h2>Add a project</h2>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required />
          </label>
          <label>
            Client
            <select value={clientId} onChange={(event) => setClientId(event.target.value)}>
              <option value="">No client</option>
              {clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Work type
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as Project["kind"])}
            >
              <option value="billable">Billable</option>
              <option value="internal">Internal</option>
            </select>
          </label>
          <label>
            State
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as typeof status)}
            >
              <option value="draft">Draft</option>
              <option value="tentative">Tentative</option>
              <option value="confirmed">Confirmed</option>
            </select>
          </label>
          <button className="primary-button" type="submit">
            <FolderPlus aria-hidden="true" /> Add project
          </button>
        </form>
      ) : null}
      <div className="record-list">
        {projects.length === 0 ? (
          <p className="table-status">No projects yet.</p>
        ) : (
          projects.map((project) => (
            <article key={project.id}>
              <div>
                <strong>{project.name}</strong>
                <p>
                  {project.kind} · {project.status} ·{" "}
                  {clients.find((item) => item.id === project.clientId)?.name ?? "No client"}
                </p>
              </div>
              {canManage ? (
                <div className="record-actions">
                  <button
                    className="secondary-button compact"
                    type="button"
                    onClick={() => void transition(project, "complete")}
                  >
                    Complete
                  </button>
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => void transition(project, "archive")}
                  >
                    Archive
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}

export function ForecastPage() {
  const [forecast, setForecast] = useState<ForecastResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getForecast(13, undefined, controller.signal)
      .then(setForecast)
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError")
          setError(friendlyError(loadError, "Could not load the forecast."));
      });
    return () => controller.abort();
  }, []);
  const first = forecast?.weeks[0];
  return (
    <section className="data-page" aria-labelledby="forecast-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">13-week advisory view</p>
          <h1 id="forecast-title">Forecast</h1>
          <p>
            {first
              ? `Confirmed work uses ${first.confirmedUtilizationPercent ?? 0}% of capacity in the first week. Potential work raises that to ${first.potentialUtilizationPercent ?? 0}%.`
              : "Capacity will appear when people and schedules exist."}
          </p>
        </div>
        <div className="segmented">
          <button
            type="button"
            className={view === "chart" ? "active" : undefined}
            onClick={() => setView("chart")}
          >
            Chart
          </button>
          <button
            type="button"
            className={view === "table" ? "active" : undefined}
            onClick={() => setView("table")}
          >
            Table
          </button>
        </div>
      </header>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {forecast ? (
        <>
          <p className="form-notice">
            {forecast.assumptions} Timezone: {forecast.timezone}.
          </p>
          {view === "chart" ? (
            <div
              className="forecast-chart"
              role="img"
              aria-label="Confirmed and potential utilization by week"
            >
              {forecast.weeks.map((week) => (
                <div className="forecast-bar" key={week.weekStart}>
                  <span>{format(parseISO(week.weekStart), "d MMM")}</span>
                  <div>
                    <i
                      style={{ width: `${Math.min(100, week.potentialUtilizationPercent ?? 0)}%` }}
                    />
                    <b
                      style={{ width: `${Math.min(100, week.confirmedUtilizationPercent ?? 0)}%` }}
                    />
                  </div>
                  <strong>{week.confirmedUtilizationPercent ?? 0}%</strong>
                </div>
              ))}
            </div>
          ) : (
            <ForecastTable forecast={forecast} />
          )}
        </>
      ) : (
        <p className="table-status">Loading forecast…</p>
      )}
    </section>
  );
}

function ForecastTable({ forecast }: { forecast: ForecastResponse }) {
  return (
    <div className="table-scroll">
      <table className="admin-table">
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Capacity</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Potential</th>
            <th scope="col">Target gap</th>
          </tr>
        </thead>
        <tbody>
          {forecast.weeks.map((week) => (
            <tr key={week.weekStart}>
              <th scope="row">{format(parseISO(week.weekStart), "d MMM yyyy")}</th>
              <td>{hours(week.capacityMinutes)}</td>
              <td>
                {week.confirmedUtilizationPercent === null
                  ? "N/A"
                  : `${week.confirmedUtilizationPercent}%`}
              </td>
              <td>
                {week.potentialUtilizationPercent === null
                  ? "N/A"
                  : `${week.potentialUtilizationPercent}%`}
              </td>
              <td>{hours(week.billableTargetGapMinutes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const placeholderCopy = {
  leave: [
    "Leave",
    "Leave management is the next UI follow-up. Capacity calculations already include leave and holidays.",
  ],
} as const;
export function PlaceholderPage({ kind }: { kind: keyof typeof placeholderCopy }) {
  const [title, description] = placeholderCopy[kind];
  return (
    <section className="placeholder-page" aria-labelledby={`${kind}-title`}>
      <p className="eyebrow">Verified backend / UI follow-up</p>
      <h1 id={`${kind}-title`}>{title}</h1>
      <p>{description}</p>
      <div className="milestone-note">
        <span>Honest boundary</span>
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
      <p>Secondary planning and account destinations.</p>
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
          {busy ? "Logging out…" : "Log out"}
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
