import type { AppRole } from "@agency-workload/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { SessionContext } from "../src/auth-service.js";
import type { ApplicationServices } from "../src/services.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const session: SessionContext = {
  sessionId,
  userId,
  organizationId,
  role: "owner",
  csrfHash: Buffer.alloc(32),
  absoluteExpiresAt: new Date("2030-01-01T00:00:00Z"),
};

function services(role: AppRole = "owner"): ApplicationServices {
  const context = { ...session, role };
  return {
    auth: {
      requestCode: vi.fn(async () => ({
        message: "If an active account exists, a code will be sent." as const,
      })),
      verifyCode: vi.fn(async () => ({
        sessionToken: "opaque-session",
        csrfToken: "csrf-token",
        context,
      })),
      getSession: vi.fn(async (token) => (token === "opaque-session" ? context : null)),
      csrfToken: vi.fn(() => "csrf-token"),
      verifyCsrf: vi.fn((_session, token) => token === "csrf-token"),
      logout: vi.fn(async () => undefined),
    },
    admin: {
      listMemberships: vi.fn(async () => []),
      listInvitations: vi.fn(async () => []),
      createInvitation: vi.fn(async (_actor, _email, invitedRole) => ({
        id: "44444444-4444-4444-8444-444444444444" as `${string}-${string}-${string}-${string}-${string}`,
        role: invitedRole,
        status: "pending" as const,
        deliveryStatus: "sent" as const,
      })),
      resendInvitation: vi.fn(async () => ({ deliveryStatus: "sent" as const })),
      changeRole: vi.fn(async () => undefined),
      deactivate: vi.fn(async () => undefined),
      revokeSession: vi.fn(async () => undefined),
      readAudit: vi.fn(async () => []),
    },
    close: vi.fn(async () => undefined),
  };
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function appWith(
  service = services(),
  environment: "development" | "production" | "test" = "development",
) {
  const app = await buildApp({
    logger: false,
    config: { appOrigin: "http://localhost:3100", environment },
    services: service,
  });
  apps.push(app);
  return app;
}

describe("auth HTTP boundary", () => {
  it("returns the same bounded request response and rejects wrong origins or extra input", async () => {
    const app = await appWith();
    const valid = await app.inject({
      method: "POST",
      url: "/api/v1/auth/request-code",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      payload: { email: "person@example.com" },
    });
    expect(valid.statusCode).toBe(202);
    expect(valid.json()).toEqual({ message: "If an active account exists, a code will be sent." });
    expect(valid.headers["access-control-allow-origin"]).toBeUndefined();

    const wrongOrigin = await app.inject({
      method: "POST",
      url: "/api/v1/auth/request-code",
      headers: { origin: "http://attacker.invalid", "content-type": "application/json" },
      payload: { email: "person@example.com" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    const extra = await app.inject({
      method: "POST",
      url: "/api/v1/auth/request-code",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      payload: { email: "person@example.com", password: "prohibited" },
    });
    expect(extra.statusCode).toBe(400);
  });

  it("issues only an opaque hardened cookie and returns recoverable CSRF state", async () => {
    const app = await appWith();
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-code",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      payload: { email: "person@example.com", code: "123456" },
    });
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toEqual({
      authenticated: true,
      csrfToken: "csrf-token",
      user: { id: userId, organizationId, role: "owner" },
    });
    const cookie = verified.headers["set-cookie"] as string;
    expect(cookie).toContain("agency_workload_session_dev=opaque-session");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toContain("Domain=");

    const current = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie: "agency_workload_session_dev=opaque-session" },
    });
    expect(current.json()).toMatchObject({ authenticated: true, csrfToken: "csrf-token" });
  });

  it("requires CSRF for logout and revokes only through POST", async () => {
    const service = services();
    const app = await appWith(service);
    const missing = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin: "http://localhost:3100",
        "content-type": "application/json",
        cookie: "agency_workload_session_dev=opaque-session",
      },
      payload: {},
    });
    expect(missing.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin: "http://localhost:3100",
        "content-type": "application/json",
        cookie: "agency_workload_session_dev=opaque-session",
        "x-csrf-token": "csrf-token",
      },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(service.auth.logout).toHaveBeenCalledOnce();
    const cleared = accepted.headers["set-cookie"] as string;
    expect(cleared).toContain("agency_workload_session_dev=");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("Path=/");
    expect(cleared).not.toContain("Domain=");
    expect(cleared).not.toContain("Secure");
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/logout" })).statusCode).toBe(404);
  });

  it("uses a __Host cookie in production and clears the identical hardened cookie", async () => {
    const app = await appWith(services(), "production");
    const verified = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-code",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      payload: { email: "person@example.com", code: "123456" },
    });
    const setCookie = verified.headers["set-cookie"] as string;
    expect(setCookie).toContain("__Host-agency_workload_session=opaque-session");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");

    const logout = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: {
        origin: "http://localhost:3100",
        "content-type": "application/json",
        cookie: "__Host-agency_workload_session=opaque-session",
        "x-csrf-token": "csrf-token",
      },
      payload: {},
    });
    const cleared = logout.headers["set-cookie"] as string;
    expect(cleared).toContain("__Host-agency_workload_session=");
    expect(cleared).toContain("Secure");
    expect(cleared).toContain("HttpOnly");
    expect(cleared).toContain("SameSite=Lax");
    expect(cleared).toContain("Path=/");
    expect(cleared).not.toContain("Domain=");
  });

  it("applies a strict route-level IP rate limit to request-code", async () => {
    const app = await appWith();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/request-code",
        remoteAddress: "198.51.100.10",
        headers: { origin: "http://localhost:3100", "content-type": "application/json" },
        payload: { email: "person@example.com" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(202));
    expect(statuses[10]).toBe(429);
  });

  it("protects invitation resend with session and CSRF", async () => {
    const service = services();
    const app = await appWith(service);
    const path = "/api/v1/admin/invitations/44444444-4444-4444-8444-444444444444/resend";
    const missingCsrf = await app.inject({
      method: "POST",
      url: path,
      headers: {
        origin: "http://localhost:3100",
        "content-type": "application/json",
        cookie: "agency_workload_session_dev=opaque-session",
      },
      payload: {},
    });
    expect(missingCsrf.statusCode).toBe(403);
    const accepted = await app.inject({
      method: "POST",
      url: path,
      headers: {
        origin: "http://localhost:3100",
        "content-type": "application/json",
        cookie: "agency_workload_session_dev=opaque-session",
        "x-csrf-token": "csrf-token",
      },
      payload: {},
    });
    expect(accepted.statusCode).toBe(200);
    expect(service.admin.resendInvitation).toHaveBeenCalledOnce();
  });

  it("does not write email, OTP, or request bodies to logs and returns allowlisted errors", async () => {
    let logs = "";
    const service = services();
    service.auth.verifyCode = vi.fn(async () => {
      throw new Error("internal failure");
    });
    const app = await buildApp({
      logger: { level: "warn", stream: { write: (line: string) => (logs += line) } },
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/verify-code",
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      payload: { email: "private-person@example.com", code: "654321" },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: "internal_error" });
    expect(logs.includes("private-person")).toBe(false);
    expect(logs.includes("654321")).toBe(false);
    expect(logs.includes("internal failure")).toBe(false);
  });
});
