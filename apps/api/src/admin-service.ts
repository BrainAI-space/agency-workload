import { randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import type { Pool, PoolClient } from "pg";
import type { SessionContext } from "./auth-service.js";
import { HttpError } from "./errors.js";
import { type AdminAction, can, canAssignRole } from "./rbac.js";
import { hashOpaqueToken, newOpaqueToken, normalizeEmail } from "./security.js";

export interface InvitationSender {
  sendInvitationCode(organizationId: string, email: string, ip: string): Promise<void>;
}

export type InvitationDeliveryStatus = "pending" | "sent" | "failed";

export class AdminService {
  constructor(
    private readonly pool: Pool,
    private readonly invitationSender: InvitationSender,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private authorize(actor: SessionContext, action: AdminAction): void {
    if (!can(actor.role, action)) throw new HttpError(403, "forbidden");
  }

  async listMemberships(actor: SessionContext) {
    this.authorize(actor, "membership:list");
    const result = await this.pool.query(
      `SELECT m.user_id AS "userId", u.email, m.role, m.active, m.created_at AS "createdAt"
       FROM app.memberships m JOIN app.users u ON u.id = m.user_id
       WHERE m.organization_id = $1 ORDER BY u.email`,
      [actor.organizationId],
    );
    return result.rows;
  }

  async listInvitations(actor: SessionContext) {
    this.authorize(actor, "invitation:list");
    const result = await this.pool.query(
      `SELECT id, email, role, status, expires_at AS "expiresAt", created_at AS "createdAt"
              , delivery_status AS "deliveryStatus", delivery_attempts AS "deliveryAttempts"
       FROM app.invitations WHERE organization_id = $1 ORDER BY created_at DESC`,
      [actor.organizationId],
    );
    return result.rows;
  }

  async createInvitation(actor: SessionContext, rawEmail: string, role: AppRole, ip: string) {
    this.authorize(actor, "invitation:create");
    if (!canAssignRole(actor.role, role)) throw new HttpError(403, "role_assignment_forbidden");
    const email = normalizeEmail(rawEmail);
    const id = randomUUID();
    const now = this.now();
    try {
      await this.withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT 1 FROM app.users u JOIN app.memberships m ON m.user_id = u.id
           WHERE u.email = $1 AND m.active`,
          [email],
        );
        if (existing.rowCount) throw new HttpError(409, "already_member");
        await client.query(
          `INSERT INTO app.invitations
           (id, organization_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            id,
            actor.organizationId,
            email,
            role,
            hashOpaqueToken(newOpaqueToken()),
            actor.userId,
            new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
          ],
        );
        await this.audit(client, actor, "invitation.created", "invitation", id, { role });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        throw new HttpError(409, "invitation_exists");
      throw error;
    }
    const deliveryStatus = await this.deliverInvitation(id, actor.organizationId, email, ip, true);
    return { id, role, status: "pending" as const, deliveryStatus };
  }

  async resendInvitation(
    actor: SessionContext,
    invitationId: string,
    ip: string,
  ): Promise<{ deliveryStatus: InvitationDeliveryStatus }> {
    this.authorize(actor, "invitation:create");
    const now = this.now();
    const invitation = await this.withTransaction(async (client) => {
      const result = await client.query<{
        email: string;
        status: string;
        expires_at: Date;
        delivery_attempts: number;
        last_delivery_at: Date | null;
      }>(
        `SELECT email, status, expires_at, delivery_attempts, last_delivery_at
         FROM app.invitations WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [invitationId, actor.organizationId],
      );
      const row = result.rows[0];
      if (!row) throw new HttpError(404, "invitation_not_found");
      if (row.status !== "pending") throw new HttpError(409, "invitation_not_resendable");
      if (row.expires_at <= now) throw new HttpError(409, "invitation_expired");
      if (row.delivery_attempts >= 5) throw new HttpError(429, "invitation_resend_limited");
      if (row.last_delivery_at && now.getTime() - row.last_delivery_at.getTime() < 60_000) {
        throw new HttpError(429, "invitation_resend_limited");
      }
      await client.query(
        `UPDATE app.invitations
         SET delivery_status = 'pending', delivery_attempts = delivery_attempts + 1,
             last_delivery_at = $1, delivery_error_at = NULL
         WHERE id = $2`,
        [now, invitationId],
      );
      await this.audit(client, actor, "invitation.resent", "invitation", invitationId);
      return row;
    });
    return {
      deliveryStatus: await this.deliverInvitation(
        invitationId,
        actor.organizationId,
        invitation.email,
        ip,
        false,
      ),
    };
  }

  async changeRole(actor: SessionContext, targetUserId: string, role: AppRole): Promise<void> {
    this.authorize(actor, "membership:role");
    if (targetUserId === actor.userId) throw new HttpError(403, "self_role_change_forbidden");
    if (!canAssignRole(actor.role, role)) throw new HttpError(403, "role_assignment_forbidden");
    await this.withTransaction(async (client) => {
      await this.lockOwners(client, actor.organizationId);
      const target = await client.query<{ role: AppRole; active: boolean }>(
        `SELECT role, active FROM app.memberships
         WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
        [actor.organizationId, targetUserId],
      );
      const current = target.rows[0];
      if (!current) throw new HttpError(404, "membership_not_found");
      if (actor.role !== "owner" && current.role === "owner") throw new HttpError(403, "forbidden");
      if (current.role === "owner" && role !== "owner")
        await this.requireAnotherOwner(client, actor.organizationId, targetUserId);
      await client.query(
        `UPDATE app.memberships SET role = $1, updated_at = $2
         WHERE organization_id = $3 AND user_id = $4`,
        [role, this.now(), actor.organizationId, targetUserId],
      );
      await this.audit(client, actor, "membership.role_changed", "user", targetUserId, { role });
    });
  }

  async deactivate(actor: SessionContext, targetUserId: string): Promise<void> {
    this.authorize(actor, "membership:deactivate");
    if (targetUserId === actor.userId) throw new HttpError(403, "self_disable_forbidden");
    await this.withTransaction(async (client) => {
      await this.lockOwners(client, actor.organizationId);
      const target = await client.query<{ role: AppRole; active: boolean }>(
        `SELECT role, active FROM app.memberships
         WHERE organization_id = $1 AND user_id = $2 FOR UPDATE`,
        [actor.organizationId, targetUserId],
      );
      const current = target.rows[0];
      if (!current) throw new HttpError(404, "membership_not_found");
      if (actor.role !== "owner" && current.role === "owner") throw new HttpError(403, "forbidden");
      if (current.role === "owner" && current.active)
        await this.requireAnotherOwner(client, actor.organizationId, targetUserId);
      await client.query(
        `UPDATE app.memberships SET active = false, updated_at = $1
         WHERE organization_id = $2 AND user_id = $3`,
        [this.now(), actor.organizationId, targetUserId],
      );
      await client.query(
        `UPDATE app.sessions SET revoked_at = $1
         WHERE organization_id = $2 AND user_id = $3 AND revoked_at IS NULL`,
        [this.now(), actor.organizationId, targetUserId],
      );
      await this.audit(client, actor, "membership.deactivated", "user", targetUserId);
    });
  }

  async revokeSession(actor: SessionContext, sessionId: string): Promise<void> {
    this.authorize(actor, "session:revoke");
    await this.withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE app.sessions SET revoked_at = $1
         WHERE id = $2 AND organization_id = $3 AND revoked_at IS NULL RETURNING user_id`,
        [this.now(), sessionId, actor.organizationId],
      );
      if (!result.rowCount) throw new HttpError(404, "session_not_found");
      await this.audit(client, actor, "session.revoked", "session", sessionId);
    });
  }

  async readAudit(actor: SessionContext) {
    this.authorize(actor, "audit:read");
    const result = await this.pool.query(
      `SELECT id, actor_user_id AS "actorUserId", action, target_type AS "targetType",
              target_id AS "targetId", details, created_at AS "createdAt"
       FROM app.audit_events WHERE organization_id = $1
       ORDER BY created_at DESC, id DESC LIMIT 100`,
      [actor.organizationId],
    );
    return result.rows;
  }

  private async lockOwners(client: PoolClient, organizationId: string): Promise<void> {
    await client.query(
      `SELECT user_id FROM app.memberships
       WHERE organization_id = $1 AND role = 'owner' AND active ORDER BY user_id FOR UPDATE`,
      [organizationId],
    );
  }

  private async requireAnotherOwner(
    client: PoolClient,
    organizationId: string,
    targetUserId: string,
  ): Promise<void> {
    const other = await client.query(
      `SELECT 1 FROM app.memberships
       WHERE organization_id = $1 AND role = 'owner' AND active AND user_id <> $2 LIMIT 1`,
      [organizationId, targetUserId],
    );
    if (!other.rowCount) throw new HttpError(409, "last_owner_protected");
  }

  private async audit(
    client: PoolClient,
    actor: SessionContext,
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, string> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO app.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [randomUUID(), actor.organizationId, actor.userId, action, targetType, targetId, details],
    );
  }

  private async deliverInvitation(
    invitationId: string,
    organizationId: string,
    email: string,
    ip: string,
    initial: boolean,
  ): Promise<InvitationDeliveryStatus> {
    const now = this.now();
    if (initial) {
      await this.pool.query(
        `UPDATE app.invitations
         SET delivery_status = 'pending', delivery_attempts = delivery_attempts + 1,
             last_delivery_at = $1, delivery_error_at = NULL
         WHERE id = $2 AND organization_id = $3 AND status = 'pending'`,
        [now, invitationId, organizationId],
      );
    }
    try {
      await this.invitationSender.sendInvitationCode(organizationId, email, ip);
      await this.pool.query(
        `UPDATE app.invitations SET delivery_status = 'sent', delivery_error_at = NULL
         WHERE id = $1 AND organization_id = $2`,
        [invitationId, organizationId],
      );
      return "sent";
    } catch {
      await this.pool.query(
        `UPDATE app.invitations SET delivery_status = 'failed', delivery_error_at = $1
         WHERE id = $2 AND organization_id = $3`,
        [this.now(), invitationId, organizationId],
      );
      return "failed";
    }
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
