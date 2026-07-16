import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAppRouter } from "./app";
import type { EarliestStartResult, NamedItem, Person, Project } from "./lib/api";
import { addCivilDays, planningPeriod, startFinderNotBefore } from "./lib/planning-calendar";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  requestCode: vi.fn(),
  verifyCode: vi.fn(),
  logout: vi.fn(),
  listMembers: vi.fn(),
  listInvitations: vi.fn(),
  listAudit: vi.fn(),
  createInvitation: vi.fn(),
  resendInvitation: vi.fn(),
  changeMemberRole: vi.fn(),
  deactivateMember: vi.fn(),
  getPlanningSettings: vi.fn(),
  listPeople: vi.fn(),
  listProjects: vi.fn(),
  listAllocations: vi.fn(),
  getSchedule: vi.fn(),
  getForecast: vi.fn(),
  listTeams: vi.fn(),
  listDeliveryRoles: vi.fn(),
  listTags: vi.fn(),
  listClients: vi.fn(),
  createClient: vi.fn(),
  createPerson: vi.fn(),
  createProject: vi.fn(),
  createAllocation: vi.fn(),
  archivePerson: vi.fn(),
  transitionProject: vi.fn(),
  findEarliestStart: vi.fn(),
}));

vi.mock("./lib/api", () => ({ api: mocks, ApiError: class extends Error {} }));

const unauthenticated = { authenticated: false };
const ownerSession = {
  authenticated: true,
  csrfToken: "csrf-memory",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "owner",
  },
};

function renderRoute(path: string) {
  const router = createMemoryAppRouter([path]);
  render(<RouterProvider router={router} />);
  return router;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function personRecord(id: string, name: string, deliveryRoleId: string | null = null): Person {
  return {
    id,
    name,
    teamId: null,
    deliveryRoleId,
    activeFrom: "2030-01-01",
    activeUntil: null,
    rowVersion: 1,
  };
}

function projectRecord(id: string, name: string, status: Project["status"] = "confirmed"): Project {
  return {
    id,
    clientId: null,
    name,
    kind: "billable",
    status,
    targetStart: null,
    targetEnd: null,
    rowVersion: 1,
    completedAt: status === "completed" ? "2030-01-01T00:00:00.000Z" : null,
  };
}

describe("Agency Workload app routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSession.mockResolvedValue(unauthenticated);
    mocks.requestCode.mockResolvedValue({
      message: "If an active account exists, a code will be sent.",
    });
    mocks.verifyCode.mockResolvedValue(ownerSession);
    mocks.logout.mockResolvedValue({ ok: true });
    mocks.listMembers.mockResolvedValue([]);
    mocks.listInvitations.mockResolvedValue([]);
    mocks.listAudit.mockResolvedValue([]);
    mocks.createInvitation.mockResolvedValue({
      id: "33333333-3333-4333-8333-333333333333",
      role: "viewer",
      status: "pending",
      deliveryStatus: "sent",
    });
    mocks.resendInvitation.mockResolvedValue({ deliveryStatus: "sent" });
    mocks.getPlanningSettings.mockResolvedValue({
      timezone: "UTC",
      weekStartsOn: 1,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    mocks.listPeople.mockResolvedValue([]);
    mocks.listProjects.mockResolvedValue([]);
    mocks.listAllocations.mockResolvedValue([]);
    mocks.getSchedule.mockResolvedValue({
      start: "2030-01-07",
      end: "2030-02-03",
      scenario: "confirmed_and_tentative",
      people: [],
      conflicts: [],
    });
    mocks.getForecast.mockResolvedValue({
      generatedAt: "2030-01-07T00:00:00.000Z",
      timezone: "UTC",
      weekStartsOn: 1,
      assumptions: "Advisory forecast.",
      weeks: [],
    });
    mocks.listTeams.mockResolvedValue([]);
    mocks.listDeliveryRoles.mockResolvedValue([]);
    mocks.listTags.mockResolvedValue([]);
    mocks.listClients.mockResolvedValue([]);
    mocks.createClient.mockResolvedValue({
      id: "77777777-7777-4777-8777-777777777777",
      name: "New Client",
      rowVersion: 1,
    });
    mocks.createPerson.mockResolvedValue({});
    mocks.createProject.mockResolvedValue({});
    mocks.createAllocation.mockResolvedValue({});
    mocks.archivePerson.mockResolvedValue({ ok: true });
    mocks.transitionProject.mockResolvedValue({ ok: true });
    mocks.findEarliestStart.mockResolvedValue([]);
  });

  it("redirects protected routes only after the session loading state resolves", async () => {
    renderRoute("/schedule");
    expect(screen.getByText(/checking your session/i)).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: /sign in to agency workload/i }),
    ).toBeVisible();
  });

  it("does not flash login or verify forms while session loading is unresolved", async () => {
    let resolveSession!: (value: typeof unauthenticated) => void;
    mocks.getSession.mockReturnValue(
      new Promise((resolve) => {
        resolveSession = resolve;
      }),
    );
    renderRoute("/login");
    expect(screen.getByText(/checking your session/i)).toBeVisible();
    expect(screen.queryByLabelText(/work email/i)).not.toBeInTheDocument();
    resolveSession(unauthenticated);
    expect(await screen.findByLabelText(/work email/i)).toBeVisible();

    window.sessionStorage.setItem("agency-workload:login-email", "person@example.com");
    mocks.getSession.mockReturnValue(new Promise(() => undefined));
    renderRoute("/verify");
    expect(screen.getAllByText(/checking your session/i).at(-1)).toBeVisible();
    expect(screen.queryByLabelText(/six-digit code/i)).not.toBeInTheDocument();
  });

  it("requests a code without password/social/signup UI and keeps email out of URLs/localStorage", async () => {
    const router = renderRoute("/login");
    const email = await screen.findByLabelText(/work email/i);
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sign up|google|github|facebook/i)).not.toBeInTheDocument();
    fireEvent.change(email, { target: { value: "person@example.com" } });
    const emailForm = email.closest("form");
    if (!emailForm) throw new Error("email form unavailable");
    fireEvent.submit(emailForm);
    expect(await screen.findByRole("heading", { name: /enter your code/i })).toBeVisible();
    expect(router.state.location.pathname).toBe("/verify");
    expect(router.state.location.search).toBe("");
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.getItem("agency-workload:login-email")).toBe("person@example.com");
  });

  it("accepts pasted digits only, verifies, clears email handoff, and reaches schedule", async () => {
    window.sessionStorage.setItem("agency-workload:login-email", "person@example.com");
    const router = renderRoute("/verify");
    const code = await screen.findByLabelText(/six-digit code/i);
    fireEvent.change(code, { target: { value: "12a 34-56" } });
    expect(code).toHaveValue("123456");
    const codeForm = code.closest("form");
    if (!codeForm) throw new Error("code form unavailable");
    fireEvent.submit(codeForm);
    expect(await screen.findByRole("heading", { name: /schedule/i })).toBeVisible();
    expect(mocks.verifyCode).toHaveBeenCalledWith("person@example.com", "123456");
    expect(window.sessionStorage.getItem("agency-workload:login-email")).toBeNull();
    expect(router.state.location.pathname).toBe("/schedule");
  });

  it("renders desktop schedule semantics and a separate mobile weekly brief without fake records", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    renderRoute("/schedule");
    expect(await screen.findByRole("heading", { name: /schedule/i })).toBeVisible();
    expect(screen.getByRole("table", { name: /people by week/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /weekly brief/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /find capacity/i })).toBeEnabled();
    expect(await screen.findByText(/no people yet/i)).toBeVisible();
  });

  it("loads planning settings and applies organization calendar boundaries", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.getPlanningSettings.mockResolvedValue({
      timezone: "Asia/Dhaka",
      weekStartsOn: 7,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    const expected = planningPeriod(new Date(), "Asia/Dhaka", 7, 0, 4);
    renderRoute("/schedule");
    expect(await screen.findByRole("heading", { name: /schedule/i })).toBeVisible();
    await waitFor(() =>
      expect(mocks.getSchedule).toHaveBeenCalledWith(
        expected.start,
        expected.end,
        "confirmed_and_tentative",
        expect.any(AbortSignal),
      ),
    );
  });

  it("never defaults Start Finder before organization today in a past period", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const past = planningPeriod(new Date(), "UTC", 1, -4, 4);
    renderRoute("/schedule");
    await screen.findByRole("button", { name: /find capacity/i });
    fireEvent.click(screen.getByRole("button", { name: "Previous period" }));
    await waitFor(() =>
      expect(mocks.getSchedule).toHaveBeenCalledWith(
        past.start,
        past.end,
        "confirmed_and_tentative",
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    expect(screen.getByLabelText("Not before")).toHaveValue(startFinderNotBefore(past));
  });

  it("keeps the core schedule usable when an optional catalog fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listTeams.mockClear();
    mocks.listDeliveryRoles.mockClear();
    mocks.listTags.mockClear();
    mocks.getSchedule.mockClear();
    mocks.listTeams.mockRejectedValueOnce(new Error("teams unavailable"));
    mocks.listDeliveryRoles.mockResolvedValueOnce([
      { id: "99999999-9999-4999-8999-999999999999", name: "Engineer", rowVersion: 1 },
    ]);
    mocks.listTags.mockResolvedValueOnce([
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "TypeScript", rowVersion: 1 },
    ]);
    mocks.listPeople.mockResolvedValueOnce([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: "99999999-9999-4999-8999-999999999999",
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    renderRoute("/schedule");
    expect(await screen.findByText("Jamie Rivera")).toBeVisible();
    expect(screen.getByRole("table", { name: /people by week/i })).toBeVisible();
    expect(screen.queryByText(/planning board could not be loaded/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    expect(within(finder).getByText(/optional filters are unavailable: teams/i)).toBeVisible();
    expect(within(finder).getByRole("option", { name: "Engineer" })).toBeInTheDocument();
    expect(within(finder).getByRole("option", { name: "TypeScript" })).toBeInTheDocument();
    fireEvent.click(within(finder).getByRole("button", { name: "Close" }));

    fireEvent.change(screen.getByLabelText("Scenario"), { target: { value: "confirmed" } });
    await waitFor(() => expect(mocks.getSchedule).toHaveBeenCalledTimes(2));
    expect(mocks.listTeams).toHaveBeenCalledTimes(1);
    expect(mocks.listDeliveryRoles).toHaveBeenCalledTimes(1);
    expect(mocks.listTags).toHaveBeenCalledTimes(1);
  });

  it("hides tentative allocation slips in confirmed-only mode", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Tentative Launch",
        kind: "billable",
        status: "tentative",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.listAllocations.mockResolvedValue([
      {
        id: "66666666-6666-4666-8666-666666666666",
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2020-01-01",
        endDate: "2035-01-01",
        mode: "minutes_per_day",
        minutesPerDay: 240,
        capacityPercent: null,
        state: "tentative",
        rowVersion: 1,
      },
    ]);
    renderRoute("/schedule");
    expect((await screen.findAllByText("Tentative Launch")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /tentative launch/i })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Scenario"), { target: { value: "confirmed" } });
    await waitFor(() => expect(screen.queryAllByText("Tentative Launch")).toHaveLength(0));
  });

  it("reports populated mobile metrics from only the first displayed week", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const period = planningPeriod(new Date(), "UTC", 1, 0, 4);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "First Week",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        name: "Later Week",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.getSchedule.mockResolvedValue({
      start: period.start,
      end: period.end,
      scenario: "confirmed_and_tentative",
      people: [
        {
          personId: "44444444-4444-4444-8444-444444444444",
          days: [
            {
              date: addCivilDays(period.start, 1),
              confirmedMinutes: 60,
              tentativeMinutes: 0,
              availableConfirmedMinutes: 420,
              availableScenarioMinutes: 420,
            },
          ],
        },
        {
          personId: "55555555-5555-4555-8555-555555555555",
          days: [
            {
              date: addCivilDays(period.start, 8),
              confirmedMinutes: 480,
              tentativeMinutes: 0,
              availableConfirmedMinutes: 0,
              availableScenarioMinutes: 0,
            },
          ],
        },
      ],
      conflicts: [{ date: addCivilDays(period.start, 1) }, { date: addCivilDays(period.start, 8) }],
    });
    renderRoute("/schedule");
    const brief = await screen.findByRole("region", { name: /weekly brief/i });
    const peopleMetric = within(brief).getByText("People scheduled").parentElement;
    const conflictMetric = within(brief).getByText("Capacity conflicts").parentElement;
    const availableMetric = within(brief).getByText("Available").parentElement;
    if (!peopleMetric || !conflictMetric || !availableMetric) throw new Error("metric unavailable");
    await waitFor(() => expect(peopleMetric).toHaveTextContent("1"));
    expect(conflictMetric).toHaveTextContent("1");
    expect(availableMetric).toHaveTextContent("7h");
  });

  it("suppresses stale schedule data while a scenario reload fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const period = planningPeriod(new Date(), "UTC", 1, 0, 4);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Old Project",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.listAllocations.mockResolvedValue([
      {
        id: "66666666-6666-4666-8666-666666666666",
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2020-01-01",
        endDate: "2035-01-01",
        mode: "minutes_per_day",
        minutesPerDay: 600,
        capacityPercent: null,
        state: "confirmed",
        rowVersion: 1,
      },
    ]);
    mocks.getSchedule
      .mockResolvedValueOnce({
        start: period.start,
        end: period.end,
        scenario: "confirmed_and_tentative",
        people: [],
        conflicts: [
          {
            personId: "44444444-4444-4444-8444-444444444444",
            date: period.start,
            severity: "confirmed",
            overbookMinutes: 120,
            fingerprint: "confirmed-conflict",
          },
        ],
      })
      .mockRejectedValueOnce(new Error("offline"));
    renderRoute("/schedule");
    await screen.findByText(/1 conflicts/i);
    expect(screen.getAllByText("Old Project").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Scenario"), { target: { value: "confirmed" } });
    await screen.findByRole("alert");
    expect(screen.getByText(/0 conflicts/i)).toBeVisible();
    expect(screen.queryByText("Old Project")).not.toBeInTheDocument();
  });

  it("forbids ordinary roles from admin routes and provides an accessible not-found page", async () => {
    mocks.getSession.mockResolvedValue({
      ...ownerSession,
      user: { ...ownerSession.user, role: "member" },
    });
    renderRoute("/admin/members");
    expect(await screen.findByRole("heading", { name: /access restricted/i })).toBeVisible();
    renderRoute("/missing-route");
    expect(await screen.findByRole("heading", { name: /page not found/i })).toBeVisible();
  });

  it("logs out with the in-memory CSRF token and returns to login", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    renderRoute("/schedule");
    const logout = await screen.findByRole("button", { name: /log out/i });
    fireEvent.click(logout);
    await waitFor(() => expect(mocks.logout).toHaveBeenCalledWith("csrf-memory"));
    expect(
      await screen.findByRole("heading", { name: /sign in to agency workload/i }),
    ).toBeVisible();
  });

  it("shows logout failures inline without unhandled navigation", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.logout.mockRejectedValue(new Error("network unavailable"));
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /log out/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not log out/i);
    expect(screen.getByRole("heading", { name: /schedule/i })).toBeVisible();
  });

  it("uses the approved five mobile destinations and exposes Leave and Admin through More", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const router = renderRoute("/schedule");
    const mobile = await screen.findByRole("navigation", { name: /mobile navigation/i });
    expect(Array.from(mobile.querySelectorAll("a")).map((link) => link.textContent)).toEqual([
      "Plan",
      "Forecast",
      "Projects",
      "People",
      "More",
    ]);
    fireEvent.click(screen.getByRole("link", { name: "More" }));
    expect(await screen.findByRole("heading", { name: /more/i })).toBeVisible();
    fireEvent.click(
      within(screen.getByRole("navigation", { name: /more destinations/i })).getByRole("link", {
        name: /leave/i,
      }),
    );
    expect(await screen.findByRole("heading", { name: /leave/i })).toBeVisible();
    await router.navigate("/more");
    expect(await screen.findByRole("link", { name: /administration/i })).toBeVisible();
  });

  it("renders manager allocation slips as noninteractive content and keeps Plan Work explicit", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2026-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Client launch",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.listAllocations.mockResolvedValue([
      {
        id: "66666666-6666-4666-8666-666666666666",
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2020-01-01",
        endDate: "2035-01-01",
        mode: "minutes_per_day",
        minutesPerDay: 240,
        capacityPercent: null,
        state: "confirmed",
        rowVersion: 1,
      },
    ]);
    mocks.getSchedule.mockResolvedValue({
      start: "2026-01-01",
      end: "2026-12-31",
      scenario: "confirmed_and_tentative",
      people: [{ personId: "44444444-4444-4444-8444-444444444444", days: [] }],
      conflicts: [],
    });

    renderRoute("/schedule");

    expect(await screen.findByText("Jamie Rivera")).toBeVisible();
    const slip = screen.getAllByText("Client launch")[0]?.closest(".allocation-slip");
    expect(slip).toBeInstanceOf(HTMLDivElement);
    expect(slip).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("button", { name: /client launch/i })).not.toBeInTheDocument();
    fireEvent.click(slip as HTMLElement);
    expect(screen.queryByRole("dialog", { name: /new allocation/i })).not.toBeInTheDocument();
    const planWork = screen.getByRole("button", { name: /^plan work$/i });
    expect(planWork).toBeVisible();
    fireEvent.click(planWork);
    expect(await screen.findByRole("dialog", { name: /new allocation/i })).toBeVisible();
    expect(screen.queryByText(/no people yet/i)).not.toBeInTheDocument();
  });

  it("creates a person through the accessible planning form", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    renderRoute("/people");

    const name = await screen.findByLabelText(/^name$/i);
    fireEvent.change(name, { target: { value: "Morgan Lee" } });
    const form = name.closest("form");
    if (!form) throw new Error("person form unavailable");
    fireEvent.submit(form);

    await waitFor(() =>
      expect(mocks.createPerson).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Morgan Lee", schedule: expect.any(Array) }),
        "csrf-memory",
      ),
    );
  });

  it("allows only one in-flight person create even when the form handler reenters", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const existing = personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Jamie Rivera");
    mocks.listPeople.mockResolvedValueOnce([existing]).mockResolvedValueOnce([existing]);
    const create = deferred<object>();
    mocks.createPerson.mockImplementation(() => create.promise);
    renderRoute("/people");

    const name = await screen.findByLabelText(/^name$/i);
    const addPerson = screen.getByRole("button", { name: /add person/i });
    await waitFor(() => expect(addPerson).toBeEnabled());
    fireEvent.change(name, { target: { value: "Morgan Lee" } });
    const form = name.closest("form");
    if (!form) throw new Error("person form unavailable");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createPerson).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Adding person…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive Jamie Rivera" })).toBeDisabled();

    await act(async () => create.resolve({}));
    expect(await screen.findByText("Person created.")).toBeVisible();
    expect(mocks.createPerson).toHaveBeenCalledTimes(1);
  });

  it("allows only one in-flight person archive even when its handler reenters", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const jamie = personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Jamie Rivera");
    const morgan = personRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Morgan Lee");
    mocks.listPeople.mockResolvedValueOnce([jamie, morgan]).mockResolvedValueOnce([morgan]);
    const archive = deferred<{ ok: true }>();
    mocks.archivePerson.mockImplementation(() => archive.promise);
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderRoute("/people");
      const archiveJamie = await screen.findByRole("button", { name: "Archive Jamie Rivera" });
      act(() => {
        archiveJamie.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        archiveJamie.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.archivePerson).toHaveBeenCalledTimes(1);
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Archiving Jamie Rivera…" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Archive Morgan Lee" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /add person/i })).toBeDisabled();

      await act(async () => archive.resolve({ ok: true }));
      expect(await screen.findByText("Person archived.")).toBeVisible();
      expect(mocks.archivePerson).toHaveBeenCalledTimes(1);
    } finally {
      confirmation.mockRestore();
    }
  });

  it("blocks people mutations until the initial authoritative list resolves", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockReset();
    mocks.createPerson.mockReset();
    const initialPeople = deferred<Person[]>();
    mocks.listPeople.mockImplementationOnce(() => initialPeople.promise);
    mocks.createPerson.mockResolvedValueOnce({});
    renderRoute("/people");

    const name = await screen.findByLabelText(/^name$/i);
    const addPerson = screen.getByRole("button", { name: /add person/i });
    expect(addPerson).toBeDisabled();
    fireEvent.change(name, { target: { value: "New Person" } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    expect(mocks.createPerson).not.toHaveBeenCalled();

    await act(async () => {
      initialPeople.resolve([
        personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Existing Person"),
      ]);
    });
    await waitFor(() => expect(addPerson).toBeEnabled());
    expect(screen.getByRole("button", { name: "Archive Existing Person" })).toBeEnabled();
  });

  it("keeps people mutations blocked after initial failure until retry succeeds", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople
      .mockRejectedValueOnce(new Error("people unavailable"))
      .mockResolvedValueOnce([
        personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Jamie Rivera"),
      ]);
    renderRoute("/people");

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load people/i);
    const addPerson = screen.getByRole("button", { name: /add person/i });
    expect(addPerson).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /retry people list/i }));
    expect(await screen.findByText("Jamie Rivera")).toBeVisible();
    await waitFor(() => expect(addPerson).toBeEnabled());
    expect(screen.getByRole("button", { name: "Archive Jamie Rivera" })).toBeEnabled();
  });

  it("keeps person create success distinct when the subsequent refresh fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockReset();
    mocks.createPerson.mockReset();
    mocks.listPeople
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce([personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Morgan Lee")]);
    mocks.createPerson.mockResolvedValueOnce({});
    renderRoute("/people");

    const name = await screen.findByLabelText(/^name$/i);
    await waitFor(() => expect(mocks.listPeople).toHaveBeenCalledTimes(1));
    fireEvent.change(name, { target: { value: "Morgan Lee" } });
    fireEvent.submit(name.closest("form") as HTMLFormElement);

    expect(await screen.findByText("Person created.")).toBeVisible();
    expect(name).toHaveValue("");
    expect(screen.getByText(/saved.*people list could not be refreshed/i)).toBeVisible();
    expect(screen.getByText(/actions are disabled until the list is refreshed/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /add person/i })).toBeDisabled();
    expect(screen.queryByText(/could not add this person/i)).not.toBeInTheDocument();
    expect(mocks.createPerson).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /retry people list/i }));
    expect(await screen.findByText("Morgan Lee")).toBeVisible();
    expect(mocks.createPerson).toHaveBeenCalledTimes(1);
  });

  it("keeps person archive success distinct when the subsequent refresh fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockReset();
    mocks.archivePerson.mockReset();
    mocks.listPeople
      .mockResolvedValueOnce([personRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Jamie Rivera")])
      .mockRejectedValueOnce(new Error("refresh failed"));
    mocks.archivePerson.mockResolvedValueOnce({ ok: true });
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderRoute("/people");
      fireEvent.click(await screen.findByRole("button", { name: "Archive Jamie Rivera" }));

      expect(await screen.findByText("Person archived.")).toBeVisible();
      expect(screen.getByText(/saved.*people list could not be refreshed/i)).toBeVisible();
      expect(screen.getByRole("button", { name: /retry people list/i })).toBeVisible();
      expect(screen.getByRole("button", { name: "Archive Jamie Rivera" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /add person/i })).toBeDisabled();
      expect(screen.queryByText(/could not archive this person/i)).not.toBeInTheDocument();
      expect(mocks.archivePerson).toHaveBeenCalledTimes(1);
    } finally {
      confirmation.mockRestore();
    }
  });

  it("keeps people visible when an optional team catalog fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValueOnce([
      personRecord(
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "Jamie Rivera",
        "99999999-9999-4999-8999-999999999999",
      ),
    ]);
    mocks.listTeams.mockRejectedValueOnce(new Error("teams unavailable"));
    mocks.listDeliveryRoles.mockResolvedValueOnce([
      { id: "99999999-9999-4999-8999-999999999999", name: "Engineer", rowVersion: 1 },
    ]);
    renderRoute("/people");

    expect(await screen.findByText("Jamie Rivera")).toBeVisible();
    expect(screen.getByText(/engineer.*active from/i)).toBeVisible();
    expect(screen.getByText(/optional filters are unavailable: teams/i)).toBeVisible();
    expect(screen.queryByText(/could not load people/i)).not.toBeInTheDocument();
  });

  it("shows an advisory forecast from the real response contract", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.getForecast.mockResolvedValue({
      generatedAt: "2030-01-07T00:00:00.000Z",
      timezone: "Asia/Dhaka",
      weekStartsOn: 1,
      assumptions: "Advisory forecast from current schedules.",
      weeks: [
        {
          weekStart: "2030-01-07",
          capacityMinutes: 2400,
          confirmedBillableMinutes: 900,
          confirmedInternalMinutes: 300,
          tentativeBillableMinutes: 240,
          tentativeInternalMinutes: 120,
          confirmedUtilizationPercent: 50,
          potentialUtilizationPercent: 65,
          confirmedOverbookMinutes: 0,
          potentialOverbookMinutes: 0,
          billableTargetGapMinutes: 900,
        },
      ],
    });

    renderRoute("/forecast");

    expect(await screen.findByText(/confirmed work uses 50%/i)).toBeVisible();
    expect(screen.getByText(/target gap uses confirmed billable minutes only/i)).toBeVisible();
    expect(
      screen.getByText(/potential utilization includes tentative and internal work/i),
    ).toBeVisible();
    expect(screen.getByText(/timezone: asia\/dhaka/i)).toBeVisible();
    const chart = screen.getByRole("button", { name: "Chart" });
    const table = screen.getByRole("button", { name: "Table" });
    expect(chart).toHaveAttribute("aria-pressed", "true");
    expect(table).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(table);
    expect(chart).toHaveAttribute("aria-pressed", "false");
    expect(table).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("table")).toBeVisible();
    expect(
      screen.getByRole("columnheader", { name: /target gap.*confirmed billable only/i }),
    ).toBeVisible();
    expect(
      screen.getByRole("columnheader", {
        name: /potential utilization.*confirmed.*tentative.*billable.*internal/i,
      }),
    ).toBeVisible();
  });

  it("uses backend-safe weekend-spanning results for Plan Work without automatic save", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: "88888888-8888-4888-8888-888888888888",
        deliveryRoleId: "99999999-9999-4999-8999-999999999999",
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Client launch",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.listTeams.mockResolvedValue([
      { id: "88888888-8888-4888-8888-888888888888", name: "Delivery", rowVersion: 1 },
    ]);
    mocks.listDeliveryRoles.mockResolvedValue([
      { id: "99999999-9999-4999-8999-999999999999", name: "Engineer", rowVersion: 1 },
    ]);
    mocks.listTags.mockResolvedValue([
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "TypeScript", rowVersion: 1 },
    ]);
    mocks.findEarliestStart.mockResolvedValue([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-18",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Contiguous range.",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    expect(within(finder).getByRole("status", { name: /capacity search results/i })).toBeVisible();
    fireEvent.change(within(finder).getByLabelText("Delivery role"), {
      target: { value: "99999999-9999-4999-8999-999999999999" },
    });
    fireEvent.change(within(finder).getByLabelText("Team"), {
      target: { value: "88888888-8888-4888-8888-888888888888" },
    });
    fireEvent.change(within(finder).getByLabelText("Tags"), {
      target: { value: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    fireEvent.change(within(finder).getByLabelText("Capacity scenario"), {
      target: { value: "confirmed" },
    });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));

    expect(await screen.findByText(/contiguous range/i)).toBeVisible();
    expect(screen.getByText(/7 Jan.*18 Jan/i)).toBeVisible();
    expect(mocks.findEarliestStart).toHaveBeenCalledWith(
      expect.objectContaining({
        roleId: "99999999-9999-4999-8999-999999999999",
        teamId: "88888888-8888-4888-8888-888888888888",
        tags: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
        scenario: "confirmed",
      }),
      "csrf-memory",
      expect.any(AbortSignal),
    );
    expect(mocks.createAllocation).not.toHaveBeenCalled();
    fireEvent.click(within(finder).getByRole("button", { name: /plan work/i }));
    expect(await screen.findByRole("heading", { name: /new allocation/i })).toBeVisible();
    expect(screen.getByLabelText("Person")).toHaveValue("44444444-4444-4444-8444-444444444444");
    expect(screen.getByLabelText("Start")).toHaveValue("2030-01-07");
    expect(screen.getByLabelText("End")).toHaveValue("2030-01-18");
    expect(screen.getByLabelText("Minutes per working day")).toHaveValue(240);
    expect(mocks.createAllocation).not.toHaveBeenCalled();
  });

  it("uses backend-unsafe results for split-allocation advice without automatic save", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-16",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: false,
        explanation: "Weekend and holiday dates were skipped.",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    expect(await screen.findByText(/weekend and holiday dates were skipped/i)).toBeVisible();
    expect(within(finder).queryByRole("button", { name: /plan work/i })).not.toBeInTheDocument();
    expect(
      within(finder).getByText(
        /completion range contains unavailable dates and must be planned as split allocations/i,
      ),
    ).toBeVisible();
    expect(within(finder).getByText(/finder result remains advisory/i)).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /new allocation/i })).not.toBeInTheDocument();
    expect(mocks.createAllocation).not.toHaveBeenCalled();
  });

  it("blocks Start Finder handoff when the result person is missing from the current plan", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Current Person",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        start: "2030-01-07",
        end: "2030-01-16",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Person was removed after the search began.",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    expect(await screen.findByText(/person was removed after the search began/i)).toBeVisible();
    expect(within(finder).queryByRole("button", { name: /plan work/i })).not.toBeInTheDocument();
    expect(within(finder).getByText(/result is stale.*refresh.*rerun/i)).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /new allocation/i })).not.toBeInTheDocument();
    expect(mocks.createAllocation).not.toHaveBeenCalled();
  });

  it.each([
    "member",
    "viewer",
  ] as const)("keeps Start Finder read-only for %s roles", async (role) => {
    mocks.getSession.mockResolvedValue({
      ...ownerSession,
      user: { ...ownerSession.user, role },
    });
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-18",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Read-only result",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    expect(await screen.findByText("Read-only result")).toBeVisible();
    expect(within(finder).queryByRole("button", { name: /plan work/i })).not.toBeInTheDocument();
    expect(within(finder).getByText(/results are read-only for your role/i)).toBeVisible();
    expect(screen.queryByRole("dialog", { name: /new allocation/i })).not.toBeInTheDocument();
  });

  it("clears changed Start Finder results and ignores superseded responses", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Client launch",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-18",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Initial result",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    expect(await screen.findByText("Initial result")).toBeVisible();
    fireEvent.change(within(finder).getByLabelText("Minutes per working day"), {
      target: { value: "300" },
    });
    expect(screen.queryByText("Initial result")).not.toBeInTheDocument();

    const oldRequest = deferred<EarliestStartResult[]>();
    const newRequest = deferred<EarliestStartResult[]>();
    mocks.findEarliestStart
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    fireEvent.change(within(finder).getByLabelText("Not before"), {
      target: { value: "2030-02-01" },
    });
    await waitFor(() =>
      expect(within(finder).getByRole("button", { name: /search availability/i })).toBeEnabled(),
    );
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    await act(async () => {
      newRequest.resolve([
        {
          personId: "44444444-4444-4444-8444-444444444444",
          start: "2030-02-04",
          end: "2030-02-13",
          minimumHeadroomMinutes: 180,
          continuousAllocationSafe: true,
          explanation: "New result",
        },
      ]);
    });
    expect(await screen.findByText("New result")).toBeVisible();
    await act(async () => {
      oldRequest.resolve([
        {
          personId: "44444444-4444-4444-8444-444444444444",
          start: "2030-01-20",
          end: "2030-01-24",
          minimumHeadroomMinutes: 60,
          continuousAllocationSafe: true,
          explanation: "Stale result",
        },
      ]);
    });
    expect(screen.queryByText("Stale result")).not.toBeInTheDocument();
    fireEvent.click(within(finder).getByRole("button", { name: /plan work/i }));
    expect(screen.getByLabelText("Start")).toHaveValue("2030-02-04");
    expect(screen.getByLabelText("End")).toHaveValue("2030-02-13");
    expect(screen.getByLabelText("Minutes per working day")).toHaveValue(300);
  });

  it("removes prior Start Finder controls while a rerun is pending", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Client launch",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-16",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Previous result",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    const search = within(finder).getByRole("button", { name: /search availability/i });
    fireEvent.click(search);
    expect(await screen.findByText("Previous result")).toBeVisible();
    const stalePlan = within(finder).getByRole("button", { name: /plan work/i });

    const replacement = deferred<EarliestStartResult[]>();
    mocks.findEarliestStart.mockImplementationOnce(() => replacement.promise);
    fireEvent.click(search);
    expect(screen.queryByText("Previous result")).not.toBeInTheDocument();
    expect(stalePlan).not.toBeInTheDocument();
    expect(within(finder).queryByRole("button", { name: /plan work/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /new allocation/i })).not.toBeInTheDocument();

    await act(async () => {
      replacement.resolve([
        {
          personId: "44444444-4444-4444-8444-444444444444",
          start: "2030-02-04",
          end: "2030-02-13",
          minimumHeadroomMinutes: 180,
          continuousAllocationSafe: true,
          explanation: "Replacement result",
        },
      ]);
    });
    expect(await screen.findByText("Replacement result")).toBeVisible();
    fireEvent.click(within(finder).getByRole("button", { name: /plan work/i }));
    expect(screen.getByLabelText("Start")).toHaveValue("2030-02-04");
    expect(screen.getByLabelText("End")).toHaveValue("2030-02-13");
  });

  it("contains focus in both sheets, closes on Escape, and restores the opener", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Client launch",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    renderRoute("/schedule");
    const planOpener = await screen.findByRole("button", { name: /^plan work$/i });
    planOpener.focus();
    fireEvent.click(planOpener);
    const allocation = screen.getByRole("dialog", { name: /new allocation/i });
    await waitFor(() => expect(within(allocation).getByLabelText("Person")).toHaveFocus());
    const save = within(allocation).getByRole("button", { name: /save allocation/i });
    save.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(within(allocation).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(planOpener).toHaveFocus();

    const finderOpener = screen.getByRole("button", { name: /find capacity/i });
    finderOpener.focus();
    fireEvent.click(finderOpener);
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    await waitFor(() => expect(within(finder).getByLabelText("Not before")).toHaveFocus());
    const search = within(finder).getByRole("button", { name: /search availability/i });
    search.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(within(finder).getByRole("button", { name: "Close" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(finderOpener).toHaveFocus();
  });

  it("locks document scrolling for either sheet and restores exact inline styles", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const originalRootStyle = document.documentElement.getAttribute("style");
    const originalBodyStyle = document.body.getAttribute("style");
    document.documentElement.setAttribute("style", "overflow: clip; color: red;");
    document.body.setAttribute("style", "overflow: auto; background-color: blue;");
    const expectedRootStyle = document.documentElement.getAttribute("style");
    const expectedBodyStyle = document.body.getAttribute("style");
    try {
      renderRoute("/schedule");
      fireEvent.click(await screen.findByRole("button", { name: /^plan work$/i }));
      expect(document.documentElement.style.overflow).toBe("hidden");
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(document.documentElement.getAttribute("style")).toBe(expectedRootStyle);
      expect(document.body.getAttribute("style")).toBe(expectedBodyStyle);

      fireEvent.click(screen.getByRole("button", { name: /find capacity/i }));
      expect(document.documentElement.style.overflow).toBe("hidden");
      expect(document.body.style.overflow).toBe("hidden");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(document.documentElement.getAttribute("style")).toBe(expectedRootStyle);
      expect(document.body.getAttribute("style")).toBe(expectedBodyStyle);
    } finally {
      if (screen.queryByRole("dialog")) fireEvent.keyDown(document, { key: "Escape" });
      if (originalRootStyle === null) document.documentElement.removeAttribute("style");
      else document.documentElement.setAttribute("style", originalRootStyle);
      if (originalBodyStyle === null) document.body.removeAttribute("style");
      else document.body.setAttribute("style", originalBodyStyle);
    }
  });

  it("rejects whitespace-only names in directly affected create forms", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.createPerson.mockClear();
    mocks.createClient.mockClear();
    mocks.createProject.mockClear();
    const router = renderRoute("/people");
    const personName = await screen.findByLabelText(/^name$/i);
    fireEvent.change(personName, { target: { value: "   " } });
    fireEvent.submit(personName.closest("form") as HTMLFormElement);
    expect(mocks.createPerson).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/name cannot be blank/i);

    await router.navigate("/projects");
    const clientName = await screen.findByLabelText("Client name");
    await waitFor(() => expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled());
    fireEvent.change(clientName, { target: { value: " \t " } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toHaveTextContent(/name cannot be blank/i);

    const projectName = screen.getByLabelText(/^name$/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /add project/i })).toBeEnabled());
    fireEvent.change(projectName, { target: { value: "   " } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    expect(mocks.createProject).not.toHaveBeenCalled();
  });

  it("never selects an unusable project and disables allocation when none are allocatable", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2030-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Completed project",
        kind: "billable",
        status: "completed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: "2030-01-01T00:00:00.000Z",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /plan work/i }));
    expect(screen.queryByRole("option", { name: "Completed project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save allocation/i })).toBeDisabled();
    expect(screen.getByText("There is no active project available for new work.")).toBeVisible();
  });

  it("uses configured forecast horizon and renders unavailable utilization as N/A", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.getPlanningSettings.mockResolvedValue({
      timezone: "UTC",
      weekStartsOn: 1,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 26,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    mocks.getForecast.mockResolvedValue({
      generatedAt: "2030-01-07T00:00:00.000Z",
      timezone: "UTC",
      weekStartsOn: 1,
      assumptions: "Advisory forecast.",
      weeks: [
        {
          weekStart: "2030-01-07",
          capacityMinutes: 0,
          confirmedBillableMinutes: 0,
          confirmedInternalMinutes: 0,
          tentativeBillableMinutes: 0,
          tentativeInternalMinutes: 0,
          confirmedUtilizationPercent: null,
          potentialUtilizationPercent: null,
          confirmedOverbookMinutes: 0,
          potentialOverbookMinutes: 0,
          billableTargetGapMinutes: 0,
        },
      ],
    });
    renderRoute("/forecast");
    expect(await screen.findByText(/confirmed work uses N\/A/i)).toBeVisible();
    expect(screen.getByText(/potential work raises that to N\/A/i)).toBeVisible();
    expect(mocks.getForecast).toHaveBeenCalledWith(26, undefined, expect.any(AbortSignal));
    const table = screen.getByRole("table", { name: /weekly forecast capacity and utilization/i });
    expect(table).toBeInTheDocument();
    expect(screen.getAllByRole("table")).toHaveLength(1);
    expect(table.parentElement).toHaveClass("sr-only");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(document.querySelector(".forecast-chart")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(table.parentElement).toHaveClass("table-scroll");
    expect(table.parentElement).not.toHaveClass("sr-only");
  });

  it("creates a client from the Projects workflow", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    renderRoute("/projects");
    const clientName = await screen.findByLabelText("Client name");
    const addClient = screen.getByRole("button", { name: /add client/i });
    await waitFor(() => expect(addClient).toBeEnabled());
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    const form = clientName.closest("form");
    if (!form) throw new Error("client form unavailable");
    fireEvent.submit(form);
    await waitFor(() =>
      expect(mocks.createClient).toHaveBeenCalledWith("Northstar", "csrf-memory"),
    );
    const success = await screen.findByRole("status", { name: /client creation status/i });
    expect(success).toHaveAttribute("aria-live", "polite");
    expect(success).toHaveTextContent("Client Northstar added.");
  });

  it("keeps a successful client creation successful without a follow-up refresh", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listClients.mockClear();
    mocks.createClient.mockClear();
    mocks.listClients.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("refresh failed"));
    mocks.createClient.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      name: "Northstar",
      rowVersion: 1,
    });
    renderRoute("/projects");
    const clientName = await screen.findByLabelText("Client name");
    await waitFor(() => expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled());
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);

    const clientSelect = screen.getByLabelText("Client");
    await waitFor(() => expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777"));
    expect(screen.getByRole("option", { name: "Northstar" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: /client creation status/i })).toHaveTextContent(
      "Client Northstar added.",
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
    expect(mocks.listClients).toHaveBeenCalledTimes(1);
  });

  it("clears stale client success when a later client submission fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.createClient
      .mockResolvedValueOnce({
        id: "77777777-7777-4777-8777-777777777777",
        name: "Northstar",
        rowVersion: 1,
      })
      .mockRejectedValueOnce(new Error("save failed"));
    renderRoute("/projects");
    const clientName = await screen.findByLabelText("Client name");
    const addClient = screen.getByRole("button", { name: /add client/i });
    await waitFor(() => expect(addClient).toBeEnabled());

    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    expect(
      await screen.findByRole("status", { name: /client creation status/i }),
    ).toHaveTextContent("Client Northstar added.");

    fireEvent.change(clientName, { target: { value: "Second Client" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not add this client/i);
    expect(
      screen.queryByRole("status", { name: /client creation status/i }),
    ).not.toBeInTheDocument();
  });

  it("keeps client creation disabled until the initial authoritative client list resolves", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listClients.mockClear();
    mocks.createClient.mockClear();
    const initialClients = deferred<NamedItem[]>();
    mocks.listClients.mockImplementationOnce(() => initialClients.promise);
    mocks.createClient.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      name: "Northstar",
      rowVersion: 1,
    });
    renderRoute("/projects");
    const clientName = await screen.findByLabelText("Client name");
    const addClient = screen.getByRole("button", { name: /add client/i });
    const addProject = screen.getByRole("button", { name: /add project/i });
    expect(screen.getByText(/client options are loading/i)).toBeVisible();
    expect(addClient).toBeDisabled();
    expect(addProject).toBeDisabled();
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    expect(mocks.createClient).not.toHaveBeenCalled();

    await act(async () => initialClients.resolve([]));
    await waitFor(() => expect(addClient).toBeEnabled());
    expect(addProject).toBeEnabled();
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    const clientSelect = screen.getByLabelText("Client");
    await waitFor(() => expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777"));
    expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777");
    expect(screen.getByRole("option", { name: "Northstar" })).toBeInTheDocument();
  });

  it("keeps client creation separate while an initial project failure blocks project actions", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockReset();
    mocks.listClients.mockReset();
    mocks.createClient.mockReset();
    const initialProjects = deferred<Project[]>();
    const initialClients = deferred<NamedItem[]>();
    mocks.listProjects
      .mockImplementationOnce(() => initialProjects.promise)
      .mockResolvedValueOnce([]);
    mocks.listClients.mockImplementationOnce(() => initialClients.promise);
    mocks.createClient.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      name: "Northstar",
      rowVersion: 1,
    });
    renderRoute("/projects");

    await act(async () => initialClients.resolve([]));
    const clientName = await screen.findByLabelText("Client name");
    await waitFor(() => expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled());
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(screen.getByLabelText("Client")).toHaveValue("77777777-7777-4777-8777-777777777777"),
    );
    await act(async () => initialProjects.reject(new Error("projects unavailable")));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load projects.");
    expect(screen.getByRole("option", { name: "Northstar" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled();
    const addProject = screen.getByRole("button", { name: /add project/i });
    expect(addProject).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /retry project list/i }));
    await waitFor(() => expect(addProject).toBeEnabled());
    expect(screen.queryByText(/could not load projects/i)).not.toBeInTheDocument();
  });

  it("allows only one in-flight project create while client creation remains independent", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const existing = projectRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Existing Project");
    mocks.listProjects.mockResolvedValueOnce([existing]).mockResolvedValueOnce([existing]);
    const create = deferred<object>();
    mocks.createProject.mockImplementation(() => create.promise);
    renderRoute("/projects");

    const name = await screen.findByLabelText(/^name$/i);
    const addProject = screen.getByRole("button", { name: /add project/i });
    await waitFor(() => expect(addProject).toBeEnabled());
    fireEvent.change(name, { target: { value: "New Project" } });
    const form = name.closest("form");
    if (!form) throw new Error("project form unavailable");
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Adding project…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Complete Existing Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive Existing Project" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled();

    await act(async () => create.resolve({}));
    expect(await screen.findByText("Project created.")).toBeVisible();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["complete", "Completing", "completed"],
    ["archive", "Archiving", "archived"],
  ] as const)("allows only one in-flight project %s while all lifecycle actions are disabled", async (action, busyVerb, successVerb) => {
    mocks.getSession.mockResolvedValue(ownerSession);
    const launch = projectRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Client Launch");
    const audit = projectRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "Second Audit");
    mocks.listProjects.mockResolvedValueOnce([launch, audit]).mockResolvedValueOnce([audit]);
    const transition = deferred<{ ok: true }>();
    mocks.transitionProject.mockImplementation(() => transition.promise);
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderRoute("/projects");
      const actionButton = await screen.findByRole("button", {
        name: `${action === "complete" ? "Complete" : "Archive"} Client Launch`,
      });
      act(() => {
        actionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        actionButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });

      expect(mocks.transitionProject).toHaveBeenCalledTimes(1);
      expect(confirmation).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: `${busyVerb} Client Launch…` })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Complete Second Audit" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Archive Second Audit" })).toBeDisabled();
      expect(screen.getByRole("button", { name: /add project/i })).toBeDisabled();
      expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled();

      await act(async () => transition.resolve({ ok: true }));
      expect(await screen.findByText(`Project ${successVerb}.`)).toBeVisible();
      expect(mocks.transitionProject).toHaveBeenCalledTimes(1);
    } finally {
      confirmation.mockRestore();
    }
  });

  it("keeps project create success distinct when the subsequent refresh fails", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockReset();
    mocks.createProject.mockReset();
    mocks.listProjects
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce([
        projectRecord("88888888-8888-4888-8888-888888888888", "New Project"),
      ]);
    mocks.createProject.mockResolvedValueOnce({});
    renderRoute("/projects");

    const projectName = await screen.findByLabelText(/^name$/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /add project/i })).toBeEnabled());
    fireEvent.change(projectName, { target: { value: "New Project" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);

    expect(await screen.findByText("Project created.")).toBeVisible();
    expect(projectName).toHaveValue("");
    expect(screen.getByText(/saved.*list could not be refreshed/i)).toBeVisible();
    expect(
      screen.getByText(/project actions are disabled until the list is refreshed/i),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: /retry project list/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /add project/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled();
    expect(screen.queryByText(/could not add this project/i)).not.toBeInTheDocument();
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /retry project list/i }));
    expect(await screen.findByText("New Project")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: /add project/i })).toBeEnabled());
  });

  it.each([
    ["Complete", "completed"],
    ["Archive", "archived"],
  ] as const)("keeps project %s success distinct when the subsequent refresh fails", async (buttonName, successVerb) => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockReset();
    mocks.transitionProject.mockReset();
    const project = {
      id: "55555555-5555-4555-8555-555555555555",
      clientId: null,
      name: "Client launch",
      kind: "billable" as const,
      status: "confirmed" as const,
      targetStart: null,
      targetEnd: null,
      rowVersion: 1,
      completedAt: null,
    };
    mocks.listProjects.mockResolvedValueOnce([project]).mockRejectedValueOnce(new Error("refresh"));
    mocks.transitionProject.mockResolvedValueOnce({ ok: true });
    const confirmation = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      renderRoute("/projects");
      fireEvent.click(await screen.findByRole("button", { name: `${buttonName} Client launch` }));

      expect(await screen.findByText(`Project ${successVerb}.`)).toBeVisible();
      expect(screen.getByText(/saved.*list could not be refreshed/i)).toBeVisible();
      expect(
        screen.queryByText(new RegExp(`could not ${buttonName.toLowerCase()} this project`, "i")),
      ).not.toBeInTheDocument();
      expect(mocks.transitionProject).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Archive Client launch" })).toBeDisabled();
      if (buttonName === "Complete") {
        expect(screen.getByRole("button", { name: "Complete Client launch" })).toBeDisabled();
      }
    } finally {
      confirmation.mockRestore();
    }
  });

  it("blocks both mutations after client load failure until an authoritative retry succeeds", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listClients.mockReset();
    mocks.createClient.mockReset();
    mocks.createProject.mockReset();
    mocks.listClients
      .mockRejectedValueOnce(new Error("clients unavailable"))
      .mockResolvedValueOnce([]);
    mocks.createClient.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      name: "Northstar",
      rowVersion: 1,
    });
    renderRoute("/projects");

    expect(await screen.findByText(/client options could not be verified/i)).toBeVisible();
    const addClient = screen.getByRole("button", { name: /add client/i });
    const addProject = screen.getByRole("button", { name: /add project/i });
    expect(addClient).toBeDisabled();
    expect(addProject).toBeDisabled();
    const projectName = screen.getByLabelText(/^name$/i);
    fireEvent.change(projectName, { target: { value: "Blocked Project" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    expect(mocks.createProject).not.toHaveBeenCalled();

    const clientName = screen.getByLabelText("Client name");
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    expect(mocks.createClient).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /retry client loading/i }));
    await waitFor(() => expect(addClient).toBeEnabled());
    expect(addProject).toBeEnabled();
    expect(screen.queryByText(/client options could not be verified/i)).not.toBeInTheDocument();
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    await waitFor(() => expect(mocks.createClient).toHaveBeenCalledTimes(1));
    expect(addProject).toBeEnabled();
  });

  it("keeps a created client when a project refresh resolves with stale clients", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listClients.mockClear();
    mocks.listProjects.mockClear();
    mocks.createClient.mockClear();
    mocks.createProject.mockClear();
    const staleProjectRefresh = deferred<Project[]>();
    mocks.listClients.mockResolvedValueOnce([]);
    mocks.listProjects
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => staleProjectRefresh.promise);
    mocks.createClient.mockResolvedValueOnce({
      id: "77777777-7777-4777-8777-777777777777",
      name: "Northstar",
      rowVersion: 1,
    });
    mocks.createProject.mockResolvedValueOnce({});
    renderRoute("/projects");

    const clientName = await screen.findByLabelText("Client name");
    await waitFor(() => expect(screen.getByRole("button", { name: /add client/i })).toBeEnabled());
    fireEvent.change(clientName, { target: { value: "Northstar" } });
    fireEvent.submit(clientName.closest("form") as HTMLFormElement);
    const clientSelect = screen.getByLabelText("Client");
    await waitFor(() => expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777"));

    const projectName = screen.getByLabelText(/^name$/i);
    fireEvent.change(projectName, { target: { value: "New Project" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));
    expect(mocks.listClients).toHaveBeenCalledTimes(1);
    expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777");
    await act(async () => staleProjectRefresh.resolve([]));
    expect(clientSelect).toHaveValue("77777777-7777-4777-8777-777777777777");
    expect(screen.getByRole("option", { name: "Northstar" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the exact authoritative client list on each fresh Projects mount", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listClients.mockReset();
    mocks.listClients
      .mockResolvedValueOnce([
        { id: "77777777-7777-4777-8777-777777777777", name: "Old Name", rowVersion: 1 },
      ])
      .mockResolvedValueOnce([
        { id: "77777777-7777-4777-8777-777777777777", name: "Renamed Client", rowVersion: 2 },
      ])
      .mockResolvedValueOnce([]);
    const router = renderRoute("/projects");
    expect(await screen.findByRole("option", { name: "Old Name" })).toBeInTheDocument();

    await router.navigate("/schedule");
    await screen.findByRole("heading", { name: "Schedule" });
    await router.navigate("/projects");
    expect(await screen.findByRole("option", { name: "Renamed Client" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Old Name" })).not.toBeInTheDocument();

    await router.navigate("/schedule");
    await screen.findByRole("heading", { name: "Schedule" });
    await router.navigate("/projects");
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: "Renamed Client" })).not.toBeInTheDocument(),
    );
  });

  it("blocks project creation until the initial authoritative list resolves", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockReset();
    mocks.createProject.mockReset();
    const initialProjects = deferred<Project[]>();
    mocks.listProjects.mockImplementationOnce(() => initialProjects.promise);
    mocks.createProject.mockResolvedValueOnce({});
    renderRoute("/projects");

    const projectName = await screen.findByLabelText(/^name$/i);
    const addProject = screen.getByRole("button", { name: /add project/i });
    expect(addProject).toBeDisabled();
    fireEvent.change(projectName, { target: { value: "New Project" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    expect(mocks.createProject).not.toHaveBeenCalled();
    await act(async () =>
      initialProjects.resolve([
        projectRecord("88888888-8888-4888-8888-888888888888", "Existing Project"),
      ]),
    );
    await waitFor(() => expect(addProject).toBeEnabled());
    expect(screen.getByRole("button", { name: "Complete Existing Project" })).toBeEnabled();
  });

  it("renders only valid project transitions with unique accessible names", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockResolvedValueOnce([
      projectRecord("11111111-1111-4111-8111-111111111111", "Draft Website", "draft"),
      projectRecord("22222222-2222-4222-8222-222222222222", "Tentative Audit", "tentative"),
      projectRecord("33333333-3333-4333-8333-333333333333", "Confirmed Launch", "confirmed"),
      projectRecord("44444444-4444-4444-8444-444444444444", "Completed Migration", "completed"),
      projectRecord("55555555-5555-4555-8555-555555555555", "Cancelled Redesign", "cancelled"),
    ]);
    renderRoute("/projects");

    for (const name of ["Draft Website", "Tentative Audit", "Confirmed Launch"]) {
      expect(await screen.findByRole("button", { name: `Complete ${name}` })).toBeVisible();
    }
    expect(
      screen.queryByRole("button", { name: "Complete Completed Migration" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Complete Cancelled Redesign" }),
    ).not.toBeInTheDocument();
    for (const name of [
      "Draft Website",
      "Tentative Audit",
      "Confirmed Launch",
      "Completed Migration",
      "Cancelled Redesign",
    ]) {
      expect(screen.getByRole("button", { name: `Archive ${name}` })).toBeVisible();
    }
  });

  it("gives repeated person and Start Finder actions identity-bearing accessible names", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listPeople.mockResolvedValue([
      personRecord("11111111-1111-4111-8111-111111111111", "Jamie Rivera"),
      personRecord("22222222-2222-4222-8222-222222222222", "Morgan Lee"),
    ]);
    const router = renderRoute("/people");
    expect(await screen.findByRole("button", { name: "Archive Jamie Rivera" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Archive Morgan Lee" })).toBeVisible();

    mocks.findEarliestStart.mockResolvedValueOnce([
      {
        personId: "11111111-1111-4111-8111-111111111111",
        start: "2030-01-07",
        end: "2030-01-08",
        minimumHeadroomMinutes: 120,
        continuousAllocationSafe: true,
        explanation: "Jamie is available.",
      },
      {
        personId: "22222222-2222-4222-8222-222222222222",
        start: "2030-01-07",
        end: "2030-01-08",
        minimumHeadroomMinutes: 90,
        continuousAllocationSafe: true,
        explanation: "Morgan is available.",
      },
    ]);
    await router.navigate("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    const finder = screen.getByRole("dialog", { name: /who can start/i });
    fireEvent.click(within(finder).getByRole("button", { name: /search availability/i }));
    expect(
      await within(finder).findByRole("button", { name: "Plan work for Jamie Rivera" }),
    ).toBeVisible();
    expect(within(finder).getByRole("button", { name: "Plan work for Morgan Lee" })).toBeVisible();
  });

  it("blocks overlapping project mutations while the authoritative refresh is pending", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockReset();
    mocks.createProject.mockReset();
    const firstRefresh = deferred<Project[]>();
    mocks.listProjects.mockResolvedValueOnce([]).mockImplementationOnce(() => firstRefresh.promise);
    mocks.createProject.mockResolvedValue({});
    renderRoute("/projects");
    const projectName = await screen.findByLabelText(/^name$/i);
    await waitFor(() => expect(screen.getByRole("button", { name: /add project/i })).toBeEnabled());

    fireEvent.change(projectName, { target: { value: "First Mutation" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    await waitFor(() => expect(mocks.listProjects).toHaveBeenCalledTimes(2));
    fireEvent.change(projectName, { target: { value: "Second Mutation" } });
    fireEvent.submit(projectName.closest("form") as HTMLFormElement);
    expect(mocks.createProject).toHaveBeenCalledTimes(1);
    expect(mocks.listProjects).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Adding project…" })).toBeDisabled();

    await act(async () =>
      firstRefresh.resolve([
        projectRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Authoritative Project State"),
      ]),
    );
    expect(await screen.findByText("Authoritative Project State")).toBeVisible();
    expect(screen.getByRole("button", { name: /add project/i })).toBeEnabled();
  });

  it.each([
    ["no client", null, "loading", "No client"],
    [
      "loading client data",
      "77777777-7777-4777-8777-777777777777",
      "loading",
      "Client data loading",
    ],
    ["failed client data", "77777777-7777-4777-8777-777777777777", "failed", "Client unavailable"],
    ["a known client", "77777777-7777-4777-8777-777777777777", "known", "Northstar"],
    ["an unknown client", "77777777-7777-4777-8777-777777777777", "unknown", "Client unavailable"],
  ] as const)("displays %s honestly on project records", async (_label, clientId, state, expected) => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.listProjects.mockResolvedValueOnce([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId,
        name: "Client display project",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    if (state === "loading") {
      mocks.listClients.mockImplementationOnce(() => new Promise<NamedItem[]>(() => undefined));
    } else if (state === "failed") {
      mocks.listClients.mockRejectedValueOnce(new Error("clients unavailable"));
    } else if (state === "known") {
      mocks.listClients.mockResolvedValueOnce([
        {
          id: "77777777-7777-4777-8777-777777777777",
          name: "Northstar",
          rowVersion: 1,
        },
      ]);
    } else {
      mocks.listClients.mockResolvedValueOnce([]);
    }
    renderRoute("/projects");

    const projectName = await screen.findByText("Client display project");
    const article = projectName.closest("article");
    if (!article) throw new Error("project record unavailable");
    await waitFor(() =>
      expect(within(article).getByText(`billable · confirmed · ${expected}`)).toBeVisible(),
    );
  });

  it("renders allocation slips as noninteractive content for read-only roles", async () => {
    mocks.getSession.mockResolvedValue({
      ...ownerSession,
      user: { ...ownerSession.user, role: "viewer" },
    });
    mocks.listPeople.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Jamie Rivera",
        teamId: null,
        deliveryRoleId: null,
        activeFrom: "2020-01-01",
        activeUntil: null,
        rowVersion: 1,
      },
    ]);
    mocks.listProjects.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Read Only Project",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
      },
    ]);
    mocks.listAllocations.mockResolvedValue([
      {
        id: "66666666-6666-4666-8666-666666666666",
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2020-01-01",
        endDate: "2035-01-01",
        mode: "minutes_per_day",
        minutesPerDay: 240,
        capacityPercent: null,
        state: "confirmed",
        rowVersion: 1,
      },
    ]);
    renderRoute("/schedule");
    const slip = (await screen.findAllByText("Read Only Project"))[0]?.closest(".allocation-slip");
    expect(slip).toBeInstanceOf(HTMLDivElement);
    expect(slip).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("button", { name: /read only project/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^plan work$/i })).not.toBeInTheDocument();
  });
});
