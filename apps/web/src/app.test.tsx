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
    expect(screen.getByRole("button", { name: /find capacity/i })).toBeDisabled();
    expect(
      screen.getByText(/capacity search arrives with the planning domain milestone/i),
    ).toBeVisible();
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
});
