import { randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "./config.js";
import { HttpError } from "./errors.js";
import type { GoTrueClient, VerifiedIdentity } from "./gotrue-client.js";
import type { AuthMailer } from "./mailer.js";
import {
  deriveCsrfToken,
  hashOpaqueToken,
  keyedHash,
  newOpaqueToken,
  normalizeEmail,
  verifyOpaqueToken,
} from "./security.js";

const GENERIC_MESSAGE = "If an active account exists, a code will be sent." as const;
const OTP_EXPIRY_MS = 10 * 60 * 1_000;
const RESEND_MS = 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;
const MAX_EMAIL_REQUESTS = 5;
const MAX_IP_REQUESTS = 20;
const MAX_ATTEMPTS = 5;
const MAX_SESSIONS = 5;
const IDLE_MS = 30 * 60 * 1_000;
const ABSOLUTE_MS = 12 * 60 * 60 * 1_000;

export interface SessionContext {
  sessionId: string;
  userId: string;
  organizationId: string;
  role: AppRole;
  csrfHash: Buffer;
  absoluteExpiresAt: Date;
}

export interface NewSession {
  sessionToken: string;
  csrfToken: string;
  context: SessionContext;
}

export interface RequestTiming {
  minimumMs: number;
  jitter(): number;
  monotonic(): number;
  sleep(milliseconds: number): Promise<void>;
}

const defaultTiming: RequestTiming = {
  minimumMs: 200,
  jitter: () => Math.floor(Math.random() * 26),
  monotonic: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export async function acceptPendingInvitation(
  client: PoolClient,
  organizationId: string,
  email: string,
  userId: string,
  now: Date,
): Promise<AppRole | null> {
  const invitation = await client.query<{ id: string; role: AppRole }>(
    `SELECT id, role FROM app.invitations
     WHERE organization_id = $1 AND email = $2 AND status = 'pending' AND expires_at > $3
     ORDER BY created_at LIMIT 1 FOR UPDATE`,
    [organizationId, email, now],
  );
  const invite = invitation.rows[0];
  if (!invite) return null;
  await client.query(
    `INSERT INTO app.memberships (organization_id, user_id, role, active)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true, updated_at = now()`,
    [organizationId, userId, invite.role],
  );
  await client.query(
    `UPDATE app.invitations SET status = 'accepted', accepted_by = $1, accepted_at = $2 WHERE id = $3`,
    [userId, now, invite.id],
  );
  return invite.role;
}

export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly config: AppConfig,
    private readonly gotrue: GoTrueClient,
    private readonly mailer: AuthMailer,
    private readonly now: () => Date = () => new Date(),
    private readonly timing: RequestTiming = defaultTiming,
  ) {}

  async requestCode(input: string, ip: string): Promise<{ message: typeof GENERIC_MESSAGE }> {
    const startedAt = this.timing.monotonic();
    try {
      return await this.requestCodeUnpadded(input, ip);
    } finally {
      const target = this.timing.minimumMs + Math.max(0, this.timing.jitter());
      const remaining = Math.max(0, target - (this.timing.monotonic() - startedAt));
      await this.timing.sleep(remaining);
    }
  }

  private async requestCodeUnpadded(
    input: string,
    ip: string,
  ): Promise<{ message: typeof GENERIC_MESSAGE }> {
    let email: string;
    try {
      email = normalizeEmail(input);
    } catch {
      return { message: GENERIC_MESSAGE };
    }
    const emailHash = keyedHash(email, this.config.sessionSecret);
    const ipHash = keyedHash(ip, this.config.sessionSecret);
    const now = this.now();

    const eligible = await this.pool.query<{ organization_id: string }>(
      `SELECT organization_id FROM (
         SELECT m.organization_id, 1 AS priority
         FROM app.users u JOIN app.memberships m ON m.user_id = u.id
         JOIN app.organizations o ON o.id = m.organization_id
         WHERE u.email = $1 AND u.active AND m.active AND o.active
         UNION ALL
         SELECT i.organization_id, 2 AS priority
         FROM app.invitations i JOIN app.organizations o ON o.id = i.organization_id
         WHERE i.email = $1 AND i.status = 'pending' AND i.expires_at > $2 AND o.active
       ) eligible ORDER BY priority LIMIT 1`,
      [email, now],
    );
    const organizationId = eligible.rows[0]?.organization_id;
    if (!organizationId) return { message: GENERIC_MESSAGE };

    const rates = await this.pool.query<{
      email_count: string;
      ip_count: string;
      latest: Date | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE email_hash = $1 AND sent_at > $3)::text AS email_count,
         count(*) FILTER (WHERE ip_hash = $2 AND sent_at > $3)::text AS ip_count,
         max(sent_at) FILTER (WHERE email_hash = $1) AS latest
       FROM app.auth_requests`,
      [emailHash, ipHash, new Date(now.getTime() - HOUR_MS)],
    );
    const rate = rates.rows[0];
    if (
      !rate ||
      Number(rate.email_count) >= MAX_EMAIL_REQUESTS ||
      Number(rate.ip_count) >= MAX_IP_REQUESTS ||
      (rate.latest && now.getTime() - rate.latest.getTime() < RESEND_MS)
    ) {
      return { message: GENERIC_MESSAGE };
    }

    const requestId = randomUUID();
    await this.pool.query(
      `INSERT INTO app.auth_requests
       (id, organization_id, email_hash, ip_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [requestId, organizationId, emailHash, ipHash, new Date(now.getTime() + OTP_EXPIRY_MS)],
    );
    try {
      await this.gotrue.ensureUser(email);
      const code = await this.gotrue.generateEmailOtp(email);
      await this.mailer.sendOtp({ email, code, expiresMinutes: 10, purpose: "sign-in" });
    } catch {
      // Enumeration resistance requires the same public response for identity and mail failures.
    }
    return { message: GENERIC_MESSAGE };
  }

  async sendInvitationCode(organizationId: string, email: string, ip: string): Promise<void> {
    const now = this.now();
    await this.pool.query(
      `INSERT INTO app.auth_requests
       (id, organization_id, email_hash, ip_hash, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [
        randomUUID(),
        organizationId,
        keyedHash(email, this.config.sessionSecret),
        keyedHash(ip, this.config.sessionSecret),
        new Date(now.getTime() + OTP_EXPIRY_MS),
      ],
    );
    await this.gotrue.ensureUser(email);
    const code = await this.gotrue.generateEmailOtp(email);
    await this.mailer.sendOtp({ email, code, expiresMinutes: 10, purpose: "invitation" });
  }

  async verifyCode(input: string, code: string): Promise<NewSession> {
    let email: string;
    try {
      email = normalizeEmail(input);
    } catch {
      throw new HttpError(401, "invalid_code");
    }
    if (!/^\d{6}$/.test(code)) throw new HttpError(401, "invalid_code");
    const now = this.now();
    const request = await this.pool.query<{ id: string; organization_id: string }>(
      `UPDATE app.auth_requests SET attempts = attempts + 1
       WHERE id = (
         SELECT id FROM app.auth_requests
         WHERE email_hash = $1 AND completed_at IS NULL AND expires_at > $2 AND attempts < $3
         ORDER BY sent_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id, organization_id`,
      [keyedHash(email, this.config.sessionSecret), now, MAX_ATTEMPTS],
    );
    const authRequest = request.rows[0];
    if (!authRequest) throw new HttpError(401, "invalid_code");

    let identity: VerifiedIdentity;
    try {
      identity = await this.gotrue.verifyEmailOtp(email, code);
    } catch {
      throw new HttpError(401, "invalid_code");
    }
    if (normalizeEmail(identity.email) !== email) throw new HttpError(401, "invalid_code");

    return this.withTransaction(async (client) => {
      let user = await client.query<{ id: string; gotrue_user_id: string; active: boolean }>(
        `SELECT id, gotrue_user_id, active FROM app.users
         WHERE gotrue_user_id = $1 OR email = $2 FOR UPDATE`,
        [identity.id, email],
      );
      let userRow = user.rows[0];
      if (userRow && userRow.gotrue_user_id !== identity.id)
        throw new HttpError(401, "invalid_code");

      let membership = userRow
        ? await client.query<{ role: AppRole; active: boolean }>(
            `SELECT role, active FROM app.memberships
             WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
            [authRequest.organization_id, userRow.id],
          )
        : { rows: [] as Array<{ role: AppRole; active: boolean }> };

      if (!userRow || !membership.rows[0]?.active) {
        if (!userRow) {
          const userId = randomUUID();
          user = await client.query<{ id: string; gotrue_user_id: string; active: boolean }>(
            `INSERT INTO app.users (id, gotrue_user_id, email) VALUES ($1, $2, $3)
             RETURNING id, gotrue_user_id, active`,
            [userId, identity.id, email],
          );
          userRow = user.rows[0];
        }
        if (!userRow) throw new HttpError(401, "invalid_code");
        const acceptedRole = await acceptPendingInvitation(
          client,
          authRequest.organization_id,
          email,
          userRow.id,
          now,
        );
        if (!acceptedRole) throw new HttpError(401, "invalid_code");
        membership = { rows: [{ role: acceptedRole, active: true }] };
      }

      if (!userRow?.active || !membership.rows[0]?.active) throw new HttpError(401, "invalid_code");
      const activeMembership = membership.rows[0];
      if (!activeMembership) throw new HttpError(401, "invalid_code");
      await client.query(`UPDATE app.auth_requests SET completed_at = $1 WHERE id = $2`, [
        now,
        authRequest.id,
      ]);
      await client.query(
        `UPDATE app.sessions SET revoked_at = $1 WHERE id IN (
           SELECT id FROM app.sessions WHERE user_id = $2 AND revoked_at IS NULL
           ORDER BY created_at DESC OFFSET $3
         )`,
        [now, userRow.id, MAX_SESSIONS - 1],
      );

      const sessionToken = newOpaqueToken();
      const csrfToken = deriveCsrfToken(sessionToken, this.config.sessionSecret);
      const sessionId = randomUUID();
      const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_MS);
      await client.query(
        `INSERT INTO app.sessions
         (id, organization_id, user_id, token_hash, csrf_hash, idle_expires_at, absolute_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sessionId,
          authRequest.organization_id,
          userRow.id,
          hashOpaqueToken(sessionToken),
          hashOpaqueToken(csrfToken),
          new Date(now.getTime() + IDLE_MS),
          absoluteExpiresAt,
        ],
      );
      await this.audit(
        client,
        authRequest.organization_id,
        userRow.id,
        "auth.login",
        "session",
        sessionId,
      );
      return {
        sessionToken,
        csrfToken,
        context: {
          sessionId,
          userId: userRow.id,
          organizationId: authRequest.organization_id,
          role: activeMembership.role,
          csrfHash: hashOpaqueToken(csrfToken),
          absoluteExpiresAt,
        },
      };
    });
  }

  async getSession(token: string | undefined): Promise<SessionContext | null> {
    if (!token || token.length > 128) return null;
    const now = this.now();
    const result = await this.pool.query<{
      id: string;
      user_id: string;
      organization_id: string;
      role: AppRole;
      csrf_hash: Buffer;
      absolute_expires_at: Date;
      idle_expires_at: Date;
    }>(
      `SELECT s.id, s.user_id, s.organization_id, m.role, s.csrf_hash,
              s.absolute_expires_at, s.idle_expires_at
       FROM app.sessions s
       JOIN app.users u ON u.id = s.user_id
       JOIN app.memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
       JOIN app.organizations o ON o.id = s.organization_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.active AND m.active AND o.active`,
      [hashOpaqueToken(token)],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.idle_expires_at <= now || row.absolute_expires_at <= now) {
      await this.pool.query(`UPDATE app.sessions SET revoked_at = $1 WHERE id = $2`, [now, row.id]);
      return null;
    }
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + IDLE_MS, row.absolute_expires_at.getTime()),
    );
    await this.pool.query(
      `UPDATE app.sessions SET last_seen_at = $1, idle_expires_at = $2 WHERE id = $3`,
      [now, idleExpiresAt, row.id],
    );
    return {
      sessionId: row.id,
      userId: row.user_id,
      organizationId: row.organization_id,
      role: row.role,
      csrfHash: row.csrf_hash,
      absoluteExpiresAt: row.absolute_expires_at,
    };
  }

  verifyCsrf(context: SessionContext, token: string | undefined): boolean {
    return Boolean(token && token.length <= 128 && verifyOpaqueToken(token, context.csrfHash));
  }

  csrfToken(sessionToken: string, context: SessionContext): string | null {
    const token = deriveCsrfToken(sessionToken, this.config.sessionSecret);
    return verifyOpaqueToken(token, context.csrfHash) ? token : null;
  }

  async logout(context: SessionContext): Promise<void> {
    await this.pool.query(
      `UPDATE app.sessions SET revoked_at = $1 WHERE id = $2 AND revoked_at IS NULL`,
      [this.now(), context.sessionId],
    );
  }

  private async audit(
    client: PoolClient,
    organizationId: string,
    actorUserId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    details: Record<string, string> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO app.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), organizationId, actorUserId, action, targetType, targetId, details],
    );
  }

  private async withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
