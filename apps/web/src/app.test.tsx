import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { RouterProvider } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAppRouter } from "./app";

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
  listPeople: vi.fn(),
  listProjects: vi.fn(),
  listAllocations: vi.fn(),
  getSchedule: vi.fn(),
  getForecast: vi.fn(),
  listTeams: vi.fn(),
  listDeliveryRoles: vi.fn(),
  listClients: vi.fn(),
  createPerson: vi.fn(),
  createProject: vi.fn(),
  createAllocation: vi.fn(),
  archivePerson: vi.fn(),
  transitionProject: vi.fn(),
  findEarliestStart: vi.fn(),
}));

vi.mock("./lib/api", () => ({ api: mocks }));

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

describe("Agency Workload app routes", () => {
  beforeEach(() => {
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
    mocks.listClients.mockResolvedValue([]);
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
    expect(screen.getByRole("button", { name: /find capacity/i })).toBeEnabled();
    expect(await screen.findByText(/no people yet/i)).toBeVisible();
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

  it("renders real people, projects, and allocation slips on the schedule", async () => {
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
    expect(screen.getAllByRole("button", { name: /client launch/i }).length).toBeGreaterThan(0);
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
    expect(screen.getByText(/timezone: asia\/dhaka/i)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeVisible();
  });

  it("keeps Start Finder separate from allocation creation", async () => {
    mocks.getSession.mockResolvedValue(ownerSession);
    mocks.findEarliestStart.mockResolvedValue([
      {
        personId: "44444444-4444-4444-8444-444444444444",
        start: "2030-01-07",
        end: "2030-01-18",
        minimumHeadroomMinutes: 120,
        explanation: "Weekends extend the range.",
      },
    ]);
    renderRoute("/schedule");
    fireEvent.click(await screen.findByRole("button", { name: /find capacity/i }));
    fireEvent.click(screen.getByRole("button", { name: /search availability/i }));

    expect(await screen.findByText(/weekends extend the range/i)).toBeVisible();
    expect(mocks.createAllocation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /plan separately/i }));
    expect(await screen.findByRole("heading", { name: /new allocation/i })).toBeVisible();
    expect(mocks.createAllocation).not.toHaveBeenCalled();
  });
});
