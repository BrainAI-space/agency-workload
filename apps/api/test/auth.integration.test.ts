import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertExactAuthIntegrationBoundary,
  pollForRecipientOtp,
} from "../../../tools/lib/auth-integration-boundary.mjs";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { keyedHash } from "../src/security.js";
import { createApplicationServices } from "../src/services.js";

const enabled = process.env.AW_AUTH_INTEGRATION === "1";
const mailpitOrigin = process.env.MAILPIT_ORIGIN ?? "";

if (enabled) assertExactAuthIntegrationBoundary(process.env);
const config = enabled ? loadConfig() : null;
const email = config?.bootstrapEmail ?? "";
const pool = config ? new Pool({ connectionString: config.databaseUrl, max: 2 }) : null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

function db(): Pool {
  if (!pool) throw new Error("integration pool unavailable");
  return pool;
}

function currentConfig() {
  if (!config) throw new Error("integration configuration unavailable");
  return config;
}

function currentApp() {
  if (!app) throw new Error("integration app unavailable");
  return app;
}

function responseCookie(value: string | string[] | undefined): string {
  const header = Array.isArray(value) ? value[0] : value;
  const cookie = header?.split(";", 1)[0];
  if (!cookie) throw new Error("session cookie unavailable");
  return cookie;
}

async function clearMail(): Promise<void> {
  const response = await fetch(`${mailpitOrigin}/api/v1/messages`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("Disposable Mailpit cleanup failed");
}

interface MailpitMessage {
  ID?: string;
  To?: Array<{ Address?: string }>;
}

async function messages(): Promise<MailpitMessage[]> {
  const response = await fetch(`${mailpitOrigin}/api/v1/messages?start=0&limit=50`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("Disposable Mailpit message listing failed");
  const body = (await response.json()) as { messages?: MailpitMessage[]; total?: number };
  if (!Array.isArray(body.messages) || body.messages.length !== body.total) {
    throw new Error("Disposable Mailpit message listing is incomplete");
  }
  return body.messages;
}

async function messageCount(): Promise<number> {
  return (await messages()).length;
}

async function otpFor(recipient: string): Promise<{ code: string; raw: string }> {
  return pollForRecipientOtp({ mailpitOrigin, recipient });
}

function post(path: string, payload: object, extraHeaders: Record<string, string> = {}) {
  if (!app) throw new Error("integration app unavailable");
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      origin: currentConfig().appOrigin,
      "content-type": "application/json",
      ...extraHeaders,
    },
    payload,
  });
}

describe.skipIf(!enabled)("GoTrue, Mailpit, and opaque session integration", () => {
  beforeAll(async () => {
    if (!config) throw new Error("integration configuration unavailable");
    await clearMail();
    app = await buildApp({ logger: false, config, services: createApplicationServices(config) });
  });

  beforeEach(async () => {
    await clearMail();
    await db().query(`DELETE FROM app.auth_requests WHERE email_hash = $1`, [
      keyedHash(email, currentConfig().sessionSecret),
    ]);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("requests fixed email OTP, verifies it, creates a session, enforces CSRF, and logs out", async () => {
    const requested = await post("/api/v1/auth/request-code", { email });
    expect(requested.statusCode).toBe(202);
    const captured = await otpFor(email);
    expect(/https?:\/\//i.test(captured.raw)).toBe(false);
    expect(captured.raw.includes("expires in 10 minutes")).toBe(true);

    const verified = await post("/api/v1/auth/verify-code", { email, code: captured.code });
    expect(verified.statusCode).toBe(200);
    const body = verified.json() as { csrfToken: string; authenticated: boolean };
    const cookie = responseCookie(verified.headers["set-cookie"]);
    expect(body.authenticated).toBe(true);
    expect(body.csrfToken.length).toBeGreaterThan(30);

    const current = await currentApp().inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(current.json()).toMatchObject({ authenticated: true });

    const rejected = await post("/api/v1/auth/logout", {}, { cookie });
    expect(rejected.statusCode).toBe(403);
    const logout = await post(
      "/api/v1/auth/logout",
      {},
      { cookie, "x-csrf-token": body.csrfToken },
    );
    expect(logout.statusCode).toBe(200);
    const ended = await currentApp().inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { cookie },
    });
    expect(ended.json()).toEqual({ authenticated: false });
    expect(
      (await post("/api/v1/auth/verify-code", { email, code: captured.code })).statusCode,
    ).toBe(401);
  }, 30_000);

  it("keeps unknown and disabled users generic and sends no email", async () => {
    await clearMail();
    const known = await post("/api/v1/auth/request-code", { email });
    expect(known.statusCode).toBe(202);
    await clearMail();
    const unknownEmail = `unknown-${randomBytes(6).toString("hex")}@agency-workload.local`;
    const unknown = await post("/api/v1/auth/request-code", { email: unknownEmail });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(await messageCount()).toBe(0);

    await db().query(`DELETE FROM app.auth_requests WHERE email_hash = $1`, [
      keyedHash(email, currentConfig().sessionSecret),
    ]);

    await db().query(`UPDATE app.users SET active = false WHERE email = $1`, [email]);
    try {
      const beforeRequests = await db().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.auth_requests WHERE email_hash = $1`,
        [keyedHash(email, currentConfig().sessionSecret)],
      );
      const disabled = await post("/api/v1/auth/request-code", { email });
      expect(disabled.statusCode).toBe(202);
      expect(disabled.json()).toEqual(unknown.json());
      expect(await messageCount()).toBe(0);
      const afterRequests = await db().query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.auth_requests WHERE email_hash = $1`,
        [keyedHash(email, currentConfig().sessionSecret)],
      );
      expect(beforeRequests.rows[0]?.count).toBe("0");
      expect(afterRequests.rows[0]?.count).toBe("0");
    } finally {
      await db().query(`UPDATE app.users SET active = true WHERE email = $1`, [email]);
    }
  }, 15_000);

  it("enforces resend and application request expiry without exposing OTP", async () => {
    await clearMail();
    await db().query(`DELETE FROM app.auth_requests WHERE email_hash = $1`, [
      keyedHash(email, currentConfig().sessionSecret),
    ]);
    expect((await post("/api/v1/auth/request-code", { email })).statusCode).toBe(202);
    const captured = await otpFor(email);
    expect((await post("/api/v1/auth/request-code", { email })).statusCode).toBe(202);
    expect(await messageCount()).toBe(1);
    await db().query(
      `UPDATE app.auth_requests SET expires_at = now() - interval '1 second'
       WHERE email_hash = $1 AND completed_at IS NULL`,
      [keyedHash(email, currentConfig().sessionSecret)],
    );
    expect(
      (await post("/api/v1/auth/verify-code", { email, code: captured.code })).statusCode,
    ).toBe(401);
  }, 15_000);

  it("creates and accepts an email-only invitation without creating a schedulable person", async () => {
    await clearMail();
    await db().query(`DELETE FROM app.auth_requests WHERE email_hash = $1`, [
      keyedHash(email, currentConfig().sessionSecret),
    ]);
    await post("/api/v1/auth/request-code", { email });
    const ownerOtp = await otpFor(email);
    const ownerLogin = await post("/api/v1/auth/verify-code", { email, code: ownerOtp.code });
    const ownerBody = ownerLogin.json() as { csrfToken: string };
    const ownerCookie = responseCookie(ownerLogin.headers["set-cookie"]);

    await clearMail();
    const invitedEmail = `invited-${randomBytes(6).toString("hex")}@agency-workload.local`;
    const invitation = await post(
      "/api/v1/admin/invitations",
      { email: invitedEmail, role: "viewer" },
      { cookie: ownerCookie, "x-csrf-token": ownerBody.csrfToken },
    );
    expect(invitation.statusCode).toBe(200);
    expect((invitation.json() as { id: string }).id).toMatch(/^[0-9a-f-]{36}$/);
    const invitedOtp = await otpFor(invitedEmail);
    const accepted = await post("/api/v1/auth/verify-code", {
      email: invitedEmail,
      code: invitedOtp.code,
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { user: { role: string } }).user.role).toBe("viewer");
    const appUser = await db().query<{ id: string }>(`SELECT id FROM app.users WHERE email = $1`, [
      invitedEmail,
    ]);
    const user = appUser.rows[0];
    if (!user) throw new Error("invited app user unavailable");
    const schedulablePerson = await db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.people WHERE organization_id = $1 AND email = $2`,
      [sessionOrganizationId(ownerLogin.json()), invitedEmail],
    );
    expect(schedulablePerson.rows[0]?.count).toBe("0");
  }, 30_000);
});

function sessionOrganizationId(response: unknown): string {
  if (
    !response ||
    typeof response !== "object" ||
    !("user" in response) ||
    !response.user ||
    typeof response.user !== "object" ||
    !("organizationId" in response.user) ||
    typeof response.user.organizationId !== "string"
  ) {
    throw new Error("session organization unavailable");
  }
  return response.user.organizationId;
}
