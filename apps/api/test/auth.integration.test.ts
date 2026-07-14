import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { keyedHash } from "../src/security.js";
import { createApplicationServices } from "../src/services.js";

const enabled = process.env.AW_AUTH_INTEGRATION === "1";
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
  await fetch("http://127.0.0.1:8025/api/v1/messages", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

async function messageCount(): Promise<number> {
  const response = await fetch("http://127.0.0.1:8025/api/v1/info");
  const body = (await response.json()) as { Messages?: number };
  return body.Messages ?? 0;
}

async function latestOtp(): Promise<{ code: string; raw: string }> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await fetch("http://127.0.0.1:8025/api/v1/message/latest/raw");
    if (response.ok) {
      const raw = await response.text();
      const code = raw.match(/one-time code is: (\d{6})/i)?.[1];
      if (code) return { code, raw };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Mailpit did not receive a bounded OTP message");
}

function post(path: string, payload: object, extraHeaders: Record<string, string> = {}) {
  if (!app) throw new Error("integration app unavailable");
  return app.inject({
    method: "POST",
    url: path,
    headers: {
      origin: "http://localhost:3100",
      "content-type": "application/json",
      ...extraHeaders,
    },
    payload,
  });
}

function superuserSql(sql: string): void {
  try {
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        "project-postgres",
        "psql",
        "--username",
        "myuser",
        "--dbname",
        "agency_workload",
        "--no-psqlrc",
        "--set",
        "ON_ERROR_STOP=1",
        "--quiet",
      ],
      { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
  } catch {
    throw new Error("Auth integration cleanup failed without exposing database output");
  }
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
    const captured = await latestOtp();
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
  }, 20_000);

  it("keeps unknown and disabled users generic and sends no email", async () => {
    await clearMail();
    const known = await post("/api/v1/auth/request-code", { email });
    expect(known.statusCode).toBe(202);
    await clearMail();
    const unknown = await post("/api/v1/auth/request-code", {
      email: "unknown@agency-workload.local",
    });
    expect(unknown.statusCode).toBe(202);
    expect(unknown.json()).toEqual(known.json());
    expect(await messageCount()).toBe(0);

    await db().query(`UPDATE app.users SET active = false WHERE email = $1`, [email]);
    try {
      const disabled = await post("/api/v1/auth/request-code", { email });
      expect(disabled.statusCode).toBe(202);
      expect(disabled.json()).toEqual(unknown.json());
      expect(await messageCount()).toBe(0);
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
    const captured = await latestOtp();
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
    const ownerOtp = await latestOtp();
    const ownerLogin = await post("/api/v1/auth/verify-code", { email, code: ownerOtp.code });
    const ownerBody = ownerLogin.json() as { csrfToken: string };
    const ownerCookie = responseCookie(ownerLogin.headers["set-cookie"]);

    await clearMail();
    const invitedEmail = `invited-${Date.now()}@agency-workload.local`;
    const invitation = await post(
      "/api/v1/admin/invitations",
      { email: invitedEmail, role: "viewer" },
      { cookie: ownerCookie, "x-csrf-token": ownerBody.csrfToken },
    );
    expect(invitation.statusCode).toBe(200);
    const invitationId = (invitation.json() as { id: string }).id;
    const invitedOtp = await latestOtp();
    const accepted = await post("/api/v1/auth/verify-code", {
      email: invitedEmail,
      code: invitedOtp.code,
    });
    expect(accepted.statusCode).toBe(200);
    expect((accepted.json() as { user: { role: string } }).user.role).toBe("viewer");
    const appUser = await db().query<{ id: string; gotrue_user_id: string }>(
      `SELECT id, gotrue_user_id FROM app.users WHERE email = $1`,
      [invitedEmail],
    );
    const user = appUser.rows[0];
    if (!user) throw new Error("invited app user unavailable");
    const schedulablePerson = await db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.people WHERE organization_id = $1 AND email = $2`,
      [sessionOrganizationId(ownerLogin.json()), invitedEmail],
    );
    expect(schedulablePerson.rows[0]?.count).toBe("0");

    superuserSql(`
      SET session_replication_role = replica;
      DELETE FROM app.audit_events WHERE target_id IN ('${invitationId}', '${user.id}') OR actor_user_id = '${user.id}';
      DELETE FROM app.sessions WHERE user_id = '${user.id}';
      DELETE FROM app.auth_requests WHERE email_hash = decode('', 'hex') OR organization_id IN (
        SELECT organization_id FROM app.invitations WHERE id = '${invitationId}'
      );
      DELETE FROM app.invitations WHERE id = '${invitationId}';
      DELETE FROM app.memberships WHERE user_id = '${user.id}';
      DELETE FROM app.users WHERE id = '${user.id}';
      SET session_replication_role = origin;
    `);
    await fetch(`${currentConfig().gotrueOrigin}/admin/users/${user.gotrue_user_id}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${currentConfig().gotrueServiceRoleKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ should_soft_delete: false }),
    });
  }, 20_000);
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
