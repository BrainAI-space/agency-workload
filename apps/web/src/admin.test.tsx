import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("./lib/api", () => ({ api: mocks, ApiError: class extends Error {} }));

const session = {
  authenticated: true,
  csrfToken: "csrf-memory",
  user: {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    role: "owner",
  },
};

function renderAdmin(path: string) {
  const router = createMemoryAppRouter([path]);
  render(<RouterProvider router={router} />);
  return router;
}

describe("admin operations UI", () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue(session);
    mocks.listMembers.mockResolvedValue([
      {
        userId: "33333333-3333-4333-8333-333333333333",
        email: "member@example.com",
        role: "member",
        active: true,
        createdAt: "2030-01-01T00:00:00Z",
      },
    ]);
    mocks.listInvitations.mockResolvedValue([
      {
        id: "44444444-4444-4444-8444-444444444444",
        email: "invited@example.com",
        role: "viewer",
        status: "pending",
        deliveryStatus: "failed",
        deliveryAttempts: 1,
        expiresAt: "2030-01-08T00:00:00Z",
        createdAt: "2030-01-01T00:00:00Z",
      },
    ]);
    mocks.listAudit.mockResolvedValue([
      {
        id: "55555555-5555-4555-8555-555555555555",
        actorUserId: session.user.id,
        action: "membership.role_changed",
        targetType: "user",
        targetId: "33333333-3333-4333-8333-333333333333",
        details: { role: "viewer" },
        createdAt: "2030-01-01T00:00:00Z",
      },
    ]);
    mocks.changeMemberRole.mockResolvedValue({ ok: true });
    mocks.deactivateMember.mockResolvedValue({ ok: true });
    mocks.createInvitation.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      role: "viewer",
      status: "pending",
      deliveryStatus: "sent",
    });
    mocks.resendInvitation.mockResolvedValue({ deliveryStatus: "sent" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("lists members and performs role/deactivation mutations with CSRF", async () => {
    renderAdmin("/admin/members");
    expect(await screen.findByText("member@example.com")).toBeVisible();
    fireEvent.change(screen.getByLabelText(/role for member@example.com/i), {
      target: { value: "viewer" },
    });
    await waitFor(() =>
      expect(mocks.changeMemberRole).toHaveBeenCalledWith(
        "33333333-3333-4333-8333-333333333333",
        "viewer",
        "csrf-memory",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: /deactivate member@example.com/i }));
    await waitFor(() => expect(mocks.deactivateMember).toHaveBeenCalled());
  });

  it("creates and resends invitations and exposes delivery state without codes", async () => {
    renderAdmin("/admin/invitations");
    expect(await screen.findByText("Delivery failed")).toBeVisible();
    fireEvent.change(screen.getByLabelText(/invite email/i), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/invited role/i), { target: { value: "viewer" } });
    const inviteForm = screen.getByLabelText(/invite email/i).closest("form");
    if (!inviteForm) throw new Error("invitation form unavailable");
    fireEvent.submit(inviteForm);
    await waitFor(() =>
      expect(mocks.createInvitation).toHaveBeenCalledWith(
        "new@example.com",
        "viewer",
        "csrf-memory",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /resend invitation to invited@example.com/i }),
    );
    await waitFor(() => expect(mocks.resendInvitation).toHaveBeenCalled());
    expect(document.body.textContent).not.toMatch(/\b\d{6}\b/);
  });

  it("renders audit columns without dumping raw JSON and shows authoritative server errors", async () => {
    renderAdmin("/admin/audit");
    expect(await screen.findByText("membership.role_changed")).toBeVisible();
    expect(screen.getByRole("columnheader", { name: /actor/i })).toBeVisible();
    expect(screen.getByRole("columnheader", { name: /target/i })).toBeVisible();
    expect(screen.queryByText(/\{"role"/)).not.toBeInTheDocument();

    mocks.listMembers.mockRejectedValue(new Error("Request failed"));
    renderAdmin("/admin/members");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load members/i);
  });
});
