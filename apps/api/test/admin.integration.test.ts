import { randomBytes, randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertExactPostgresIntegrationBoundary } from "../../../tools/lib/postgres-integration-boundary.mjs";
import { AdminService } from "../src/admin-service.js";
import { AuthService, acceptPendingInvitation, type SessionContext } from "../src/auth-service.js";
import { loadConfig } from "../src/config.js";
import { hashOpaqueToken } from "../src/security.js";

const enabled = process.env.AW_ADMIN_INTEGRATION === "1";
if (enabled) assertExactPostgresIntegrationBoundary(process.env, "admin");
const config = enabled ? loadConfig() : null;
const pool = config ? new Pool({ connectionString: config.databaseUrl, max: 8 }) : null;
const suffix = randomBytes(6).toString("hex");
let primaryOrganization = "";
let bootstrapOwner = "";
let service: AdminService;

function db(): Pool {
  if (!pool) throw new Error("admin integration pool unavailable");
  return pool;
}

function context(userId: string, organizationId: string, role: AppRole): SessionContext {
  return {
    sessionId: randomUUID(),
    userId,
    organizationId,
    role,
    csrfHash: Buffer.alloc(32),
    absoluteExpiresAt: new Date(Date.now() + 60_000),
  };
}

async function createUser(organizationId: string, role: AppRole): Promise<string> {
  const id = randomUUID();
  await db().query(`INSERT INTO app.users (id, gotrue_user_id, email) VALUES ($1, $2, $3)`, [
    id,
    randomUUID(),
    `${role}-${randomBytes(5).toString("hex")}@agency-workload.local`,
  ]);
  await db().query(
    `INSERT INTO app.memberships (organization_id, user_id, role) VALUES ($1, $2, $3)`,
    [organizationId, id, role],
  );
  return id;
}

async function createStandaloneUser(): Promise<{ id: string; email: string }> {
  const id = randomUUID();
  const email = `invitee-${randomBytes(5).toString("hex")}@agency-workload.local`;
  await db().query(`INSERT INTO app.users (id, gotrue_user_id, email) VALUES ($1, $2, $3)`, [
    id,
    randomUUID(),
    email,
  ]);
  return { id, email };
}

async function createOrganization(): Promise<string> {
  const id = randomUUID();
  await db().query(
    `INSERT INTO app.organizations (id, slug, name) VALUES ($1, $2, 'Integration')`,
    [id, `integration-${randomBytes(5).toString("hex")}`],
  );
  return id;
}

function startAtBarrier(operations: readonly (() => Promise<unknown>)[]) {
  let release: () => void = () => undefined;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let issued = 0;
  const promises = operations.map((operation) => {
    issued += 1;
    return barrier.then(operation);
  });
  return { issued, promises, release };
}

function expectSerializedBusinessRejection(
  results: PromiseSettledResult<unknown>[],
  publicCode: string,
): void {
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (!rejected) throw new Error("concurrency rejection unavailable");
  expect(rejected.reason).toEqual(expect.objectContaining({ publicCode, statusCode: 409 }));
  expect((rejected.reason as { code?: string }).code).not.toBe("40P01");
}

describe.skipIf(!enabled)("admin authorization and concurrency integration", () => {
  beforeAll(async () => {
    const owner = await db().query<{ user_id: string; organization_id: string }>(
      `SELECT user_id, organization_id FROM app.memberships WHERE role = 'owner' AND active ORDER BY created_at LIMIT 1`,
    );
    const ownerRow = owner.rows[0];
    if (!ownerRow) throw new Error("bootstrap owner unavailable");
    bootstrapOwner = ownerRow.user_id;
    primaryOrganization = ownerRow.organization_id;
    service = new AdminService(db(), { sendInvitationCode: async () => undefined });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("denies every admin operation to planner, member, and viewer", async () => {
    for (const role of ["planner", "member", "viewer"] as const) {
      const actor = context(randomUUID(), primaryOrganization, role);
      const operations = [
        service.listMemberships(actor),
        service.listInvitations(actor),
        service.createInvitation(
          actor,
          `denied-${suffix}@agency-workload.local`,
          "viewer",
          "127.0.0.1",
        ),
        service.changeRole(actor, randomUUID(), "viewer"),
        service.deactivate(actor, randomUUID()),
        service.revokeSession(actor, randomUUID()),
        service.resendInvitation(actor, randomUUID(), "127.0.0.1"),
        service.readAudit(actor),
      ];
      for (const operation of operations)
        await expect(operation).rejects.toMatchObject({ statusCode: 403 });
    }
  });

  it("blocks self-management, owner assignment by admin, and cross-organization IDs", async () => {
    const adminId = await createUser(primaryOrganization, "admin");
    const admin = context(adminId, primaryOrganization, "admin");
    await expect(service.changeRole(admin, adminId, "owner")).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.deactivate(admin, adminId)).rejects.toMatchObject({ statusCode: 403 });

    const otherOrganization = await createOrganization();
    const otherUser = await createUser(otherOrganization, "member");
    const otherSession = randomUUID();
    await db().query(
      `INSERT INTO app.sessions
       (id, organization_id, user_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes', now() + interval '12 hours')`,
      [otherSession, otherOrganization, otherUser, randomBytes(32), randomBytes(32)],
    );
    const owner = context(bootstrapOwner, primaryOrganization, "owner");
    await expect(service.changeRole(owner, otherUser, "viewer")).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(service.deactivate(owner, otherUser)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service.revokeSession(owner, otherSession)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("serializes concurrent owner removal and preserves one active owner", async () => {
    const organizationId = await createOrganization();
    const first = await createUser(organizationId, "owner");
    const second = await createUser(organizationId, "owner");
    const start = startAtBarrier([
      () => service.deactivate(context(first, organizationId, "owner"), second),
      () => service.deactivate(context(second, organizationId, "owner"), first),
    ]);
    expect(start.issued).toBe(2);
    start.release();
    const results = await Promise.allSettled(start.promises);
    expectSerializedBusinessRejection(results, "last_owner_protected");
    const owners = await db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.memberships
       WHERE organization_id = $1 AND role = 'owner' AND active`,
      [organizationId],
    );
    expect(Number(owners.rows[0]?.count)).toBe(1);
  });

  it("allows only one concurrent pending invitation per organization and email", async () => {
    const otherOrganization = await createOrganization();
    const otherOwner = await createUser(otherOrganization, "owner");
    const owner = context(bootstrapOwner, primaryOrganization, "owner");
    const invited = `concurrent-${suffix}@agency-workload.local`;
    const start = startAtBarrier([
      () => service.createInvitation(owner, invited, "viewer", "127.0.0.1"),
      () =>
        service.createInvitation(
          context(otherOwner, otherOrganization, "owner"),
          invited,
          "viewer",
          "127.0.0.1",
        ),
    ]);
    expect(start.issued).toBe(2);
    start.release();
    const results = await Promise.allSettled(start.promises);
    expectSerializedBusinessRejection(results, "invitation_exists");
  });

  it("serializes concurrent invitation acceptance", async () => {
    const organizationId = await createOrganization();
    const invitee = await createStandaloneUser();
    await db().query(
      `INSERT INTO app.invitations
       (id, organization_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, 'member', $4, $5, now() + interval '1 day')`,
      [randomUUID(), organizationId, invitee.email, randomBytes(32), bootstrapOwner],
    );
    const accept = async () => {
      const client = await db().connect();
      try {
        await client.query("BEGIN");
        const role = await acceptPendingInvitation(
          client,
          organizationId,
          invitee.email,
          invitee.id,
          new Date(),
        );
        await client.query("COMMIT");
        return role;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const start = startAtBarrier([accept, accept]);
    expect(start.issued).toBe(2);
    start.release();
    const results = await Promise.all(start.promises);
    expect(results.filter((role) => role === "member")).toHaveLength(1);
    expect(results.filter((role) => role === null)).toHaveLength(1);
  });

  it("persists failed invitation delivery and supports bounded protected resend", async () => {
    let currentTime = new Date("2030-01-01T00:00:00Z");
    let shouldFail = true;
    const delivery = new AdminService(
      db(),
      {
        sendInvitationCode: async () => {
          if (shouldFail) throw new Error("simulated delivery failure");
        },
      },
      () => currentTime,
    );
    const owner = context(bootstrapOwner, primaryOrganization, "owner");
    const email = `delivery-${suffix}@agency-workload.local`;
    const created = await delivery.createInvitation(owner, email, "viewer", "127.0.0.1");
    expect(created.deliveryStatus).toBe("failed");
    const failed = await db().query<{ delivery_status: string; delivery_attempts: number }>(
      `SELECT delivery_status, delivery_attempts FROM app.invitations WHERE id = $1`,
      [created.id],
    );
    expect(failed.rows[0]).toEqual({ delivery_status: "failed", delivery_attempts: 1 });

    currentTime = new Date(currentTime.getTime() + 61_000);
    shouldFail = false;
    expect((await delivery.resendInvitation(owner, created.id, "127.0.0.1")).deliveryStatus).toBe(
      "sent",
    );
    await expect(delivery.resendInvitation(owner, created.id, "127.0.0.1")).rejects.toMatchObject({
      statusCode: 429,
    });

    await db().query(
      `UPDATE app.invitations SET status = 'accepted', accepted_by = $1, accepted_at = $2 WHERE id = $3`,
      [bootstrapOwner, currentTime, created.id],
    );
    await expect(delivery.resendInvitation(owner, created.id, "127.0.0.1")).rejects.toMatchObject({
      statusCode: 409,
    });
    await db().query(
      `UPDATE app.invitations
       SET status = 'revoked', accepted_by = NULL, accepted_at = NULL WHERE id = $1`,
      [created.id],
    );
    await expect(delivery.resendInvitation(owner, created.id, "127.0.0.1")).rejects.toMatchObject({
      statusCode: 409,
    });
    await db().query(
      `UPDATE app.invitations
       SET status = 'pending', delivery_attempts = 5, last_delivery_at = NULL WHERE id = $1`,
      [created.id],
    );
    await expect(delivery.resendInvitation(owner, created.id, "127.0.0.1")).rejects.toMatchObject({
      statusCode: 429,
    });
    await db().query(
      `UPDATE app.invitations
       SET status = 'pending', delivery_attempts = 2, expires_at = $1, last_delivery_at = NULL
       WHERE id = $2`,
      [new Date(currentTime.getTime() - 1), created.id],
    );
    await expect(delivery.resendInvitation(owner, created.id, "127.0.0.1")).rejects.toMatchObject({
      publicCode: "invitation_expired",
    });
  });

  it("rolls back session revocation when audit insertion fails", async () => {
    const target = await createUser(primaryOrganization, "member");
    const targetSession = randomUUID();
    await db().query(
      `INSERT INTO app.sessions
       (id, organization_id, user_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes', now() + interval '12 hours')`,
      [targetSession, primaryOrganization, target, randomBytes(32), randomBytes(32)],
    );
    await expect(
      service.revokeSession(context(randomUUID(), primaryOrganization, "owner"), targetSession),
    ).rejects.toMatchObject({ code: "23503" });
    const state = await db().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM app.sessions WHERE id = $1`,
      [targetSession],
    );
    expect(state.rows[0]?.revoked_at).toBeNull();
  });

  it("reads role changes dynamically and revokes sessions on deactivation", async () => {
    if (!config) throw new Error("admin integration config unavailable");
    const target = await createUser(primaryOrganization, "member");
    const token = `dynamic-${randomBytes(20).toString("base64url")}`;
    const targetSession = randomUUID();
    await db().query(
      `INSERT INTO app.sessions
       (id, organization_id, user_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 minutes', now() + interval '12 hours')`,
      [targetSession, primaryOrganization, target, hashOpaqueToken(token), randomBytes(32)],
    );
    const auth = new AuthService(db(), config, {} as never, {} as never);
    expect((await auth.getSession(token))?.role).toBe("member");
    const owner = context(bootstrapOwner, primaryOrganization, "owner");
    await service.changeRole(owner, target, "viewer");
    expect((await auth.getSession(token))?.role).toBe("viewer");
    const active = await db().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM app.sessions WHERE id = $1`,
      [targetSession],
    );
    expect(active.rows[0]?.revoked_at).toBeNull();
    await service.deactivate(owner, target);
    expect(await auth.getSession(token)).toBeNull();
    const revoked = await db().query<{ revoked_at: Date | null }>(
      `SELECT revoked_at FROM app.sessions WHERE id = $1`,
      [targetSession],
    );
    expect(revoked.rows[0]?.revoked_at).toBeInstanceOf(Date);
  });
});
