import { format, parseISO } from "date-fns";
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
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
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
import {
  addCivilDays,
  type PlanningPeriod,
  planningPeriod,
  startFinderNotBefore,
  summarizeScheduleWeek,
} from "../lib/planning-calendar";
import { useContainedDialog } from "../lib/dialog-focus";

const legend = [
  ["Confirmed", "legend-confirmed"],
  ["Tentative", "legend-tentative"],
  ["Available", "legend-available"],
  ["Unavailable", "legend-leave"],
] as const;
const managers = new Set(["owner", "admin", "planner"]);

interface AllocationDraft {
  personId: string;
  startDate: string;
  endDate: string;
  minutesPerDay: number;
}

interface FinderRequestSnapshot {
  dailyMinutes: number;
}

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
    invalid_project_transition: "Completed and cancelled projects cannot be changed or completed.",
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
  const [period, setPeriod] = useState<PlanningPeriod | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [teams, setTeams] = useState<NamedItem[]>([]);
  const [roles, setRoles] = useState<NamedItem[]>([]);
  const [tags, setTags] = useState<NamedItem[]>([]);
  const [unavailableCatalogs, setUnavailableCatalogs] = useState<string[]>([]);
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [showAllocation, setShowAllocation] = useState(false);
  const [allocationDraft, setAllocationDraft] = useState<AllocationDraft | null>(null);
  const [finderOpen, setFinderOpen] = useState(false);
  const start = period?.start ?? "";
  const end = period?.end ?? "";
  const weeks = period?.weeks ?? [];

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      api.listTeams(controller.signal),
      api.listDeliveryRoles(controller.signal),
      api.listTags(controller.signal),
    ]).then(([teamsResult, rolesResult, tagsResult]) => {
      if (controller.signal.aborted) return;
      const unavailable: string[] = [];
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value);
      else unavailable.push("teams");
      if (rolesResult.status === "fulfilled") setRoles(rolesResult.value);
      else unavailable.push("delivery roles");
      if (tagsResult.status === "fulfilled") setTags(tagsResult.value);
      else unavailable.push("tags");
      setUnavailableCatalogs(unavailable);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    void reload;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setPeriod(null);
    setSchedule(null);
    setAllocations([]);
    const load = async () => {
      const settings = await api.getPlanningSettings(controller.signal);
      const nextPeriod = planningPeriod(
        new Date(),
        settings.timezone,
        settings.weekStartsOn,
        weekOffset,
        zoom,
      );
      const [nextPeople, nextProjects, nextAllocations, nextSchedule] = await Promise.all([
        api.listPeople(controller.signal),
        api.listProjects(controller.signal),
        api.listAllocations(nextPeriod.start, nextPeriod.end, controller.signal),
        api.getSchedule(nextPeriod.start, nextPeriod.end, scenario, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setPeriod(nextPeriod);
      setPeople(nextPeople);
      setProjects(nextProjects);
      setAllocations(nextAllocations);
      setSchedule(nextSchedule);
    };
    void load()
      .catch((loadError) => {
        if ((loadError as Error).name !== "AbortError") {
          setError(friendlyError(loadError, "The planning board could not be loaded."));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [scenario, weekOffset, zoom, reload]);

  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const viewSummary = summarizeScheduleWeek(schedule, start, end, scenario);
  const firstWeekEnd = start ? addCivilDays(start, 6) : "";
  const mobileSummary = summarizeScheduleWeek(schedule, start, firstWeekEnd, scenario);

  return (
    <section className="planner-page" aria-labelledby="schedule-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Planning board / live data</p>
          <h1 id="schedule-title">Schedule</h1>
        </div>
        <div className="schedule-actions">
          {canManage && period ? (
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setAllocationDraft(null);
                setShowAllocation(true);
              }}
            >
              <Plus aria-hidden="true" /> Plan work
            </button>
          ) : null}
          {period ? (
            <button className="primary-button" type="button" onClick={() => setFinderOpen(true)}>
              <Search aria-hidden="true" /> Find capacity
            </button>
          ) : null}
        </div>
      </header>

      <p className="edition-line">
        <span>Live edition</span> {viewSummary.scheduledPeople} people scheduled ·{" "}
        {viewSummary.conflictCount} conflicts · {hours(viewSummary.availableMinutes)} available
        across this view
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
            <CalendarRange aria-hidden="true" />{" "}
            {period
              ? `${format(parseISO(start), "d MMM")} – ${format(parseISO(end), "d MMM yyyy")}`
              : "Loading organization calendar"}
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
                <th scope="col" key={date}>
                  <span>{format(parseISO(date), "MMM")}</span>
                  {format(parseISO(date), "d")}
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
                      const weekEnd = addCivilDays(weekStart, 6);
                      const days =
                        personSchedule?.days.filter(
                          (day) => day.date >= weekStart && day.date <= weekEnd,
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
                          (scenario === "confirmed_and_tentative" ||
                            allocation.state === "confirmed") &&
                          allocation.endDate >= weekStart &&
                          allocation.startDate <= weekEnd,
                      );
                      return (
                        <td
                          key={weekStart}
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
                          {slips.slice(0, 3).map((allocation) => {
                            const name = projectNames.get(allocation.projectId) ?? "Project";
                            return (
                              <div
                                key={allocation.id}
                                className={`allocation-slip ${allocation.state}`}
                                title={`${name}: ${allocation.state}`}
                              >
                                <span>{name}</span>
                                <small>{allocation.state}</small>
                              </div>
                            );
                          })}
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
        <h2>{period ? format(parseISO(start), "d MMM") : "Current week"} — operating view</h2>
        <dl>
          <div>
            <dt>People scheduled</dt>
            <dd>{mobileSummary.scheduledPeople}</dd>
          </div>
          <div>
            <dt>Capacity conflicts</dt>
            <dd>{mobileSummary.conflictCount}</dd>
          </div>
          <div>
            <dt>Available</dt>
            <dd>{hours(mobileSummary.availableMinutes)}</dd>
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
          {...(allocationDraft
            ? {
                initialPersonId: allocationDraft.personId,
                initialMinutes: allocationDraft.minutesPerDay,
              }
            : {})}
          initialStart={allocationDraft?.startDate ?? start}
          initialEnd={allocationDraft?.endDate ?? firstWeekEnd}
          onClose={() => {
            setShowAllocation(false);
            setAllocationDraft(null);
          }}
          onSaved={() => {
            setShowAllocation(false);
            setAllocationDraft(null);
            setReload((value) => value + 1);
          }}
        />
      ) : null}
      {finderOpen ? (
        <StartFinder
          people={people}
          teams={teams}
          roles={roles}
          tags={tags}
          unavailableCatalogs={unavailableCatalogs}
          csrfToken={csrfToken}
          canPlan={canManage}
          initialNotBefore={period ? startFinderNotBefore(period) : start}
          onClose={() => setFinderOpen(false)}
          onPlan={(result, dailyMinutes) => {
            setFinderOpen(false);
            setAllocationDraft({
              personId: result.personId,
              startDate: result.start,
              endDate: result.end,
              minutesPerDay: dailyMinutes,
            });
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
  initialPersonId,
  initialStart,
  initialEnd,
  initialMinutes,
  onClose,
  onSaved,
}: {
  people: Person[];
  projects: Project[];
  csrfToken: string | null;
  initialPersonId?: string;
  initialStart: string;
  initialEnd: string;
  initialMinutes?: number;
  onClose(): void;
  onSaved(): void;
}) {
  const allocatableProjects = projects.filter(
    (project) => !["completed", "cancelled"].includes(project.status),
  );
  const selectedPerson =
    initialPersonId === undefined
      ? people[0]?.id
      : people.some((person) => person.id === initialPersonId)
        ? initialPersonId
        : undefined;
  const [personId, setPersonId] = useState(selectedPerson ?? "");
  const [projectId, setProjectId] = useState(allocatableProjects[0]?.id ?? "");
  const [startDate, setStartDate] = useState(initialStart);
  const [endDate, setEndDate] = useState(initialEnd);
  const [minutes, setMinutes] = useState(initialMinutes ?? 240);
  const [state, setState] = useState<Allocation["state"]>("confirmed");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { dialogRef, initialFocusRef } = useContainedDialog<HTMLSelectElement>(onClose);
  const canSubmit = Boolean(personId && allocatableProjects.length > 0 && csrfToken);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!personId || !projectId) {
      return setError("Add at least one person and one active project before planning work.");
    }
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
        ref={dialogRef}
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
        {!canSubmit ? (
          <p className="form-notice">
            {initialPersonId !== undefined && !personId
              ? "The selected person is no longer available. Close this form and rerun Start Finder."
              : people.length === 0
                ? "Add at least one person before planning work."
                : allocatableProjects.length === 0
                  ? "There is no active project available for new work."
                  : "Session security is unavailable. Refresh before planning work."}
          </p>
        ) : null}
        <form className="stack-form" onSubmit={submit}>
          <label htmlFor="allocation-person">Person</label>
          <select
            ref={initialFocusRef}
            id="allocation-person"
            value={personId}
            onChange={(event) => setPersonId(event.target.value)}
            required
          >
            {people.length === 0 ? <option value="">No person available</option> : null}
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
            disabled={allocatableProjects.length === 0}
          >
            {allocatableProjects.length === 0 ? <option value="">No active project</option> : null}
            {allocatableProjects.map((project) => (
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
          <button type="submit" className="primary-button" disabled={busy || !canSubmit}>
            {busy ? "Saving…" : "Save allocation"}
          </button>
        </form>
      </section>
    </div>
  );
}

function StartFinder({
  people,
  teams,
  roles,
  tags,
  unavailableCatalogs,
  csrfToken,
  canPlan,
  initialNotBefore,
  onClose,
  onPlan,
}: {
  people: Person[];
  teams: NamedItem[];
  roles: NamedItem[];
  tags: NamedItem[];
  unavailableCatalogs: string[];
  csrfToken: string | null;
  canPlan: boolean;
  initialNotBefore: string;
  onClose(): void;
  onPlan(result: EarliestStartResult, dailyMinutes: number): void;
}) {
  const [notBefore, setNotBefore] = useState(initialNotBefore);
  const [dailyMinutes, setDailyMinutes] = useState(240);
  const [workdayCount, setWorkdayCount] = useState(10);
  const [roleId, setRoleId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [tagId, setTagId] = useState("");
  const [scenario, setScenario] = useState<Scenario>("confirmed_and_tentative");
  const [results, setResults] = useState<EarliestStartResult[]>([]);
  const [resultRequest, setResultRequest] = useState<FinderRequestSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestVersion = useRef(0);
  const searchController = useRef<AbortController | null>(null);
  const { dialogRef, initialFocusRef } = useContainedDialog<HTMLInputElement>(onClose);
  const personNames = new Map(people.map((person) => [person.id, person.name]));
  const invalidateResults = () => {
    requestVersion.current += 1;
    searchController.current?.abort();
    searchController.current = null;
    setResults([]);
    setResultRequest(null);
    setSearched(false);
    setBusy(false);
    setError(null);
  };
  useEffect(() => () => searchController.current?.abort(), []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    searchController.current?.abort();
    const controller = new AbortController();
    searchController.current = controller;
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    const request = {
      notBefore,
      dailyMinutes,
      workdayCount,
      scenario,
      horizonDays: 180,
      ...(roleId ? { roleId } : {}),
      ...(teamId ? { teamId } : {}),
      ...(tagId ? { tags: [tagId] } : {}),
    };
    setResults([]);
    setResultRequest(null);
    setSearched(false);
    setError(null);
    setBusy(true);
    try {
      const nextResults = await api.findEarliestStart(request, csrfToken ?? "", controller.signal);
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setResults(nextResults);
      setResultRequest({
        dailyMinutes: request.dailyMinutes,
      });
      setSearched(true);
    } catch (searchError) {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setError(friendlyError(searchError, "Could not search availability."));
    } finally {
      if (requestVersion.current === version) {
        setBusy(false);
        searchController.current = null;
      }
    }
  };
  return (
    <div className="sheet-backdrop" role="presentation">
      <section
        ref={dialogRef}
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
              ref={initialFocusRef}
              type="date"
              value={notBefore}
              onChange={(event) => {
                setNotBefore(event.target.value);
                invalidateResults();
              }}
            />
          </label>
          <label>
            Minutes per working day
            <input
              type="number"
              min={1}
              max={1440}
              value={dailyMinutes}
              onChange={(event) => {
                setDailyMinutes(Number(event.target.value));
                invalidateResults();
              }}
            />
          </label>
          <label>
            Working days needed
            <input
              type="number"
              min={1}
              max={60}
              value={workdayCount}
              onChange={(event) => {
                setWorkdayCount(Number(event.target.value));
                invalidateResults();
              }}
            />
          </label>
          <label>
            Delivery role
            <select
              value={roleId}
              onChange={(event) => {
                setRoleId(event.target.value);
                invalidateResults();
              }}
            >
              <option value="">Any role</option>
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {role.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Team
            <select
              value={teamId}
              onChange={(event) => {
                setTeamId(event.target.value);
                invalidateResults();
              }}
            >
              <option value="">Any team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tags
            <select
              value={tagId}
              onChange={(event) => {
                setTagId(event.target.value);
                invalidateResults();
              }}
            >
              <option value="">Any tag</option>
              {tags.map((tag) => (
                <option key={tag.id} value={tag.id}>
                  {tag.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Capacity scenario
            <select
              value={scenario}
              onChange={(event) => {
                setScenario(event.target.value as Scenario);
                invalidateResults();
              }}
            >
              <option value="confirmed">Confirmed only</option>
              <option value="confirmed_and_tentative">Confirmed + tentative</option>
            </select>
          </label>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Searching…" : "Search availability"}
          </button>
        </form>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        {unavailableCatalogs.length > 0 ? (
          <p className="form-notice">
            Some optional filters are unavailable: {unavailableCatalogs.join(", ")}.
          </p>
        ) : null}
        {!canPlan ? (
          <p className="form-notice">
            Capacity results are read-only for your role. Ask an owner, admin, or planner to create
            an allocation.
          </p>
        ) : null}
        <div
          className="finder-results"
          role="status"
          aria-label="Capacity search results"
          aria-live="polite"
        >
          {results.length === 0 ? (
            <p>
              {searched
                ? "No matching capacity was found in this horizon."
                : "Searching never assigns work automatically."}
            </p>
          ) : (
            results.map((result) => {
              const personName = personNames.get(result.personId);
              return (
                <article key={result.personId}>
                  <strong>{personName ?? "Unavailable person"}</strong>
                  <p>
                    {format(parseISO(result.start), "d MMM")} to{" "}
                    {format(parseISO(result.end), "d MMM")} · {hours(result.minimumHeadroomMinutes)}{" "}
                    headroom
                  </p>
                  <small>{result.explanation}</small>
                  {!personName ? (
                    <p>
                      This result is stale because the person is no longer in the current plan.
                      Refresh the schedule and rerun Start Finder.
                    </p>
                  ) : null}
                  {!result.continuousAllocationSafe ? (
                    <p>
                      The completion range contains unavailable dates and must be planned as split
                      allocations; the Finder result remains advisory.
                    </p>
                  ) : null}
                  {canPlan && result.continuousAllocationSafe && personName && resultRequest ? (
                    <button
                      type="button"
                      className="secondary-button compact"
                      aria-label={`Plan work for ${personName}`}
                      onClick={() => onPlan(result, resultRequest.dailyMinutes)}
                    >
                      Plan work
                    </button>
                  ) : null}
                </article>
              );
            })
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
  const [unavailableCatalogs, setUnavailableCatalogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [peopleLoadError, setPeopleLoadError] = useState<string | null>(null);
  const [peopleRefreshWarning, setPeopleRefreshWarning] = useState<string | null>(null);
  const [peopleListState, setPeopleListState] = useState<"loading" | "ready" | "stale">("loading");
  const [peopleMutation, setPeopleMutation] = useState<
    { kind: "create" } | { kind: "archive"; personId: string } | null
  >(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [activeFrom, setActiveFrom] = useState(isoDate(new Date()));
  const [teamId, setTeamId] = useState("");
  const [roleId, setRoleId] = useState("");
  const peopleGeneration = useRef(0);
  const peopleMutationRef = useRef(false);
  const loadPeople = useCallback(async (context: "initial" | "mutation" | "retry") => {
    const generation = peopleGeneration.current + 1;
    peopleGeneration.current = generation;
    setPeopleListState("loading");
    setPeopleRefreshWarning(null);
    if (context !== "initial") setPeopleLoadError(null);
    try {
      const nextPeople = await api.listPeople();
      if (peopleGeneration.current === generation) {
        setPeople(nextPeople);
        setPeopleLoadError(null);
        setPeopleRefreshWarning(null);
        setPeopleListState("ready");
      }
    } catch (loadError) {
      if (peopleGeneration.current !== generation) return;
      setPeopleListState("stale");
      if (context === "initial") {
        setPeopleLoadError(friendlyError(loadError, "Could not load people."));
      } else {
        setPeopleRefreshWarning(
          friendlyError(
            loadError,
            context === "mutation"
              ? "The change was saved, but the people list could not be refreshed."
              : "The people list could not be refreshed.",
          ),
        );
      }
    }
  }, []);
  const peopleActionsBlocked = peopleListState !== "ready" || peopleMutation !== null;
  useEffect(() => {
    void loadPeople("initial");
  }, [loadPeople]);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      api.listTeams(controller.signal),
      api.listDeliveryRoles(controller.signal),
    ]).then(([teamsResult, rolesResult]) => {
      if (controller.signal.aborted) return;
      const unavailable: string[] = [];
      if (teamsResult.status === "fulfilled") setTeams(teamsResult.value);
      else unavailable.push("teams");
      if (rolesResult.status === "fulfilled") setRoles(rolesResult.value);
      else unavailable.push("delivery roles");
      setUnavailableCatalogs(unavailable);
    });
    return () => controller.abort();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken || peopleActionsBlocked || peopleMutationRef.current) return;
    setError(null);
    setSuccess(null);
    const trimmedName = name.trim();
    if (!trimmedName) return setError("Name cannot be blank.");
    peopleMutationRef.current = true;
    setPeopleMutation({ kind: "create" });
    try {
      await api.createPerson(
        {
          name: trimmedName,
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
      setActiveFrom(isoDate(new Date()));
      setTeamId("");
      setRoleId("");
      setSuccess("Person created.");
      await loadPeople("mutation");
    } catch (saveError) {
      setError(friendlyError(saveError, "Could not add this person."));
    } finally {
      peopleMutationRef.current = false;
      setPeopleMutation(null);
    }
  };
  const archive = async (person: Person) => {
    if (peopleActionsBlocked || peopleMutationRef.current || !csrfToken) return;
    if (!window.confirm(`Archive ${person.name}?`)) return;
    peopleMutationRef.current = true;
    setPeopleMutation({ kind: "archive", personId: person.id });
    setError(null);
    setSuccess(null);
    try {
      await api.archivePerson(person.id, person.rowVersion, csrfToken);
      setSuccess("Person archived.");
      await loadPeople("mutation");
    } catch (archiveError) {
      setError(friendlyError(archiveError, "Could not archive this person."));
    } finally {
      peopleMutationRef.current = false;
      setPeopleMutation(null);
    }
  };
  const visibleErrors = [error, peopleLoadError].filter(Boolean).join(" ");
  return (
    <section className="data-page" aria-labelledby="people-title">
      <header className="planner-heading">
        <div>
          <p className="eyebrow">Planning directory</p>
          <h1 id="people-title">People</h1>
          <p>Schedulable people remain separate from login accounts.</p>
        </div>
      </header>
      {visibleErrors ? (
        <p className="form-error" role="alert">
          {visibleErrors}
          {peopleLoadError ? (
            <>
              {" "}
              <button
                type="button"
                className="text-button"
                onClick={() => void loadPeople("retry")}
              >
                Retry people list
              </button>
            </>
          ) : null}
          {peopleLoadError ? " Actions are disabled until the list is refreshed." : null}
        </p>
      ) : null}
      {success ? (
        <p className="form-notice" role="status" aria-live="polite">
          {success}
        </p>
      ) : null}
      {peopleRefreshWarning ? (
        <p className="form-notice" role="status">
          {peopleRefreshWarning} Actions are disabled until the list is refreshed.{" "}
          <button type="button" className="text-button" onClick={() => void loadPeople("retry")}>
            Retry people list
          </button>
        </p>
      ) : null}
      {unavailableCatalogs.length > 0 ? (
        <p className="form-notice">
          Some optional filters are unavailable: {unavailableCatalogs.join(", ")}.
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
          <button className="primary-button" type="submit" disabled={peopleActionsBlocked}>
            {peopleMutation?.kind === "create" ? (
              "Adding person…"
            ) : (
              <>
                <UserPlus aria-hidden="true" /> Add person
              </>
            )}
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
                  aria-label={
                    peopleMutation?.kind === "archive" && peopleMutation.personId === person.id
                      ? `Archiving ${person.name}…`
                      : `Archive ${person.name}`
                  }
                  disabled={peopleActionsBlocked}
                  onClick={() => void archive(person)}
                >
                  {peopleMutation?.kind === "archive" && peopleMutation.personId === person.id
                    ? "Archiving…"
                    : "Archive"}
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
  const [clientName, setClientName] = useState("");
  const [clientBusy, setClientBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientSuccess, setClientSuccess] = useState<string | null>(null);
  const [projectSuccess, setProjectSuccess] = useState<string | null>(null);
  const [projectLoadError, setProjectLoadError] = useState<string | null>(null);
  const [clientLoadError, setClientLoadError] = useState<string | null>(null);
  const [clientLoadState, setClientLoadState] = useState<"failed" | "loading" | "ready">("loading");
  const [projectRefreshWarning, setProjectRefreshWarning] = useState<string | null>(null);
  const [projectListState, setProjectListState] = useState<"loading" | "ready" | "stale">(
    "loading",
  );
  const [projectMutation, setProjectMutation] = useState<
    { kind: "create" } | { kind: "archive" | "complete"; projectId: string } | null
  >(null);
  const projectGeneration = useRef(0);
  const projectMutationRef = useRef(false);
  const clientGeneration = useRef(0);
  const loadProjects = useCallback(async (context: "initial" | "mutation" | "retry") => {
    const generation = projectGeneration.current + 1;
    projectGeneration.current = generation;
    setProjectListState("loading");
    setProjectRefreshWarning(null);
    if (context !== "initial") setProjectLoadError(null);
    try {
      const nextProjects = await api.listProjects();
      if (projectGeneration.current === generation) {
        setProjects(nextProjects);
        setProjectLoadError(null);
        setProjectRefreshWarning(null);
        setProjectListState("ready");
      }
    } catch (loadError) {
      if (projectGeneration.current === generation) {
        setProjectListState("stale");
        if (context === "initial") {
          setProjectLoadError(friendlyError(loadError, "Could not load projects."));
        } else {
          setProjectRefreshWarning(
            friendlyError(
              loadError,
              context === "mutation"
                ? "The change was saved, but the project list could not be refreshed."
                : "The project list could not be refreshed.",
            ),
          );
        }
      }
    }
  }, []);
  const projectActionsBlocked = projectListState !== "ready" || projectMutation !== null;
  const loadClients = useCallback(async () => {
    const generation = clientGeneration.current + 1;
    clientGeneration.current = generation;
    setClientLoadState("loading");
    setClientLoadError(null);
    try {
      const nextClients = await api.listClients();
      if (clientGeneration.current === generation) {
        setClients(nextClients);
        setClientLoadState("ready");
      }
    } catch (loadError) {
      if (clientGeneration.current === generation) {
        setClientLoadState("failed");
        setClientLoadError(
          friendlyError(loadError, "Client options could not be verified. Retry client loading."),
        );
      }
    }
  }, []);
  useEffect(() => {
    void loadProjects("initial");
    void loadClients();
  }, [loadClients, loadProjects]);
  const submitClient = async (event: FormEvent) => {
    event.preventDefault();
    setClientSuccess(null);
    if (!csrfToken)
      return setError("Session security token is unavailable. Refresh and try again.");
    if (clientLoadState !== "ready") {
      return setError("Client options must be verified before adding a client.");
    }
    const trimmedName = clientName.trim();
    if (!trimmedName) return setError("Name cannot be blank.");
    setClientBusy(true);
    setError(null);
    try {
      const created = await api.createClient(trimmedName, csrfToken);
      clientGeneration.current += 1;
      setClientLoadError(null);
      setClientLoadState("ready");
      setClientName("");
      setClients((current) =>
        [...current.filter((client) => client.id !== created.id), created].sort((left, right) =>
          left.name.localeCompare(right.name),
        ),
      );
      setClientId(created.id);
      setClientSuccess(`Client ${trimmedName} added.`);
    } catch (saveError) {
      setClientSuccess(null);
      setError(friendlyError(saveError, "Could not add this client."));
    } finally {
      setClientBusy(false);
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!csrfToken || projectActionsBlocked || projectMutationRef.current) return;
    setError(null);
    setProjectSuccess(null);
    const trimmedName = name.trim();
    if (!trimmedName) return setError("Name cannot be blank.");
    if (clientLoadState !== "ready") {
      return setError(
        "Client options could not be verified. Retry client loading before adding a project.",
      );
    }
    projectMutationRef.current = true;
    setProjectMutation({ kind: "create" });
    try {
      await api.createProject(
        { name: trimmedName, kind, status, ...(clientId ? { clientId } : {}) },
        csrfToken,
      );
      setName("");
      setProjectSuccess("Project created.");
      await loadProjects("mutation");
    } catch (saveError) {
      setError(friendlyError(saveError, "Could not add this project."));
    } finally {
      projectMutationRef.current = false;
      setProjectMutation(null);
    }
  };
  const transition = async (project: Project, action: "archive" | "complete") => {
    if (!csrfToken || projectActionsBlocked || projectMutationRef.current) return;
    if (!window.confirm(`${action === "archive" ? "Archive" : "Complete"} ${project.name}?`))
      return;
    projectMutationRef.current = true;
    setProjectMutation({ kind: action, projectId: project.id });
    setError(null);
    setProjectSuccess(null);
    try {
      await api.transitionProject(project.id, action, project.rowVersion, csrfToken);
      setProjectSuccess(`Project ${action === "archive" ? "archived" : "completed"}.`);
      await loadProjects("mutation");
    } catch (actionError) {
      setError(friendlyError(actionError, `Could not ${action} this project.`));
    } finally {
      projectMutationRef.current = false;
      setProjectMutation(null);
    }
  };
  const visibleErrors = [error, projectLoadError].filter(Boolean).join(" ");
  const projectClientName = (project: Project) => {
    if (project.clientId === null) return "No client";
    if (clientLoadState === "loading") return "Client data loading";
    if (clientLoadState === "failed") return "Client unavailable";
    return clients.find((item) => item.id === project.clientId)?.name ?? "Client unavailable";
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
      {visibleErrors ? (
        <p className="form-error" role="alert">
          {visibleErrors}
          {projectLoadError ? (
            <>
              {" Actions are disabled until the list is refreshed. "}
              <button
                type="button"
                className="text-button"
                onClick={() => void loadProjects("retry")}
              >
                Retry project list
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {clientSuccess ? (
        <p
          className="form-notice"
          role="status"
          aria-label="Client creation status"
          aria-live="polite"
        >
          {clientSuccess}
        </p>
      ) : null}
      {projectSuccess ? (
        <p className="form-notice" role="status">
          {projectSuccess}
        </p>
      ) : null}
      {projectRefreshWarning ? (
        <p className="form-notice" role="status">
          {projectRefreshWarning} Project actions are disabled until the list is refreshed.{" "}
          <button type="button" className="text-button" onClick={() => void loadProjects("retry")}>
            Retry project list
          </button>
        </p>
      ) : null}
      {canManage && clientLoadState === "loading" ? (
        <p className="form-notice" role="status">
          Client options are loading. Client and project creation will be available after
          verification.
        </p>
      ) : null}
      {clientLoadState === "failed" && clientLoadError ? (
        <p className="form-error" role="alert">
          {clientLoadError}{" "}
          <button type="button" className="text-button" onClick={() => void loadClients()}>
            Retry client loading
          </button>
        </p>
      ) : null}
      {canManage ? (
        <>
          <form className="inline-editor client-editor" onSubmit={submitClient}>
            <h2>Add a client</h2>
            <label>
              Client name
              <input
                value={clientName}
                onChange={(event) => setClientName(event.target.value)}
                required
              />
            </label>
            <button
              className="secondary-button"
              type="submit"
              disabled={clientBusy || clientLoadState !== "ready"}
            >
              {clientBusy ? "Adding…" : "Add client"}
            </button>
          </form>
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
            <button
              className="primary-button"
              type="submit"
              disabled={clientLoadState !== "ready" || projectActionsBlocked}
            >
              {projectMutation?.kind === "create" ? (
                "Adding project…"
              ) : (
                <>
                  <FolderPlus aria-hidden="true" /> Add project
                </>
              )}
            </button>
          </form>
        </>
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
                  {project.kind} · {project.status} · {projectClientName(project)}
                </p>
              </div>
              {canManage ? (
                <div className="record-actions">
                  {["draft", "tentative", "confirmed"].includes(project.status) ? (
                    <button
                      className="secondary-button compact"
                      type="button"
                      aria-label={
                        projectMutation?.kind === "complete" &&
                        projectMutation.projectId === project.id
                          ? `Completing ${project.name}…`
                          : `Complete ${project.name}`
                      }
                      disabled={projectActionsBlocked}
                      onClick={() => void transition(project, "complete")}
                    >
                      {projectMutation?.kind === "complete" &&
                      projectMutation.projectId === project.id
                        ? "Completing…"
                        : "Complete"}
                    </button>
                  ) : null}
                  <button
                    className="danger-button"
                    type="button"
                    aria-label={
                      projectMutation?.kind === "archive" &&
                      projectMutation.projectId === project.id
                        ? `Archiving ${project.name}…`
                        : `Archive ${project.name}`
                    }
                    disabled={projectActionsBlocked}
                    onClick={() => void transition(project, "archive")}
                  >
                    {projectMutation?.kind === "archive" && projectMutation.projectId === project.id
                      ? "Archiving…"
                      : "Archive"}
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
  const [horizonWeeks, setHorizonWeeks] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"chart" | "table">("chart");
  useEffect(() => {
    const controller = new AbortController();
    void api
      .getPlanningSettings(controller.signal)
      .then((settings) => {
        setHorizonWeeks(settings.forecastHorizonWeeks);
        return api.getForecast(settings.forecastHorizonWeeks, undefined, controller.signal);
      })
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
          <p className="eyebrow">
            {horizonWeeks === null ? "Configured" : horizonWeeks}-week advisory view
          </p>
          <h1 id="forecast-title">Forecast</h1>
          <p>
            {first
              ? `Confirmed work uses ${utilization(first.confirmedUtilizationPercent)} of capacity in the first week. Potential work raises that to ${utilization(first.potentialUtilizationPercent)}.`
              : "Capacity will appear when people and schedules exist."}
          </p>
          <p>
            Target gap uses confirmed billable minutes only. Potential utilization includes
            tentative and internal work.
          </p>
        </div>
        <div className="segmented">
          <button
            type="button"
            className={view === "chart" ? "active" : undefined}
            aria-pressed={view === "chart"}
            onClick={() => setView("chart")}
          >
            Chart
          </button>
          <button
            type="button"
            className={view === "table" ? "active" : undefined}
            aria-pressed={view === "table"}
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
            <div className="forecast-chart" aria-hidden="true">
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
                  <strong>{utilization(week.confirmedUtilizationPercent)}</strong>
                </div>
              ))}
            </div>
          ) : null}
          <ForecastTable forecast={forecast} visuallyHidden={view === "chart"} />
        </>
      ) : (
        <p className="table-status">Loading forecast…</p>
      )}
    </section>
  );
}

function ForecastTable({
  forecast,
  visuallyHidden,
}: {
  forecast: ForecastResponse;
  visuallyHidden: boolean;
}) {
  return (
    <div className={visuallyHidden ? "sr-only" : "table-scroll"}>
      <table className="admin-table">
        <caption className="sr-only">Weekly forecast capacity and utilization</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Capacity</th>
            <th scope="col">Confirmed utilization (billable + internal)</th>
            <th scope="col">Potential utilization (confirmed + tentative, billable + internal)</th>
            <th scope="col">Target gap (confirmed billable only)</th>
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

function utilization(value: number | null): string {
  return value === null ? "N/A" : `${value}%`;
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
