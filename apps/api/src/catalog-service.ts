import { randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import type { Pool, PoolClient } from "pg";
import type { SessionContext } from "./auth-service.js";
import { HttpError } from "./errors.js";

export type CatalogKind = "teams" | "delivery_roles" | "tags";

const structureRoles: readonly AppRole[] = ["owner", "admin"];
const planningRoles: readonly AppRole[] = ["owner", "admin", "planner"];
const catalogConfig = {
  teams: { target: "team", personColumn: "team_id" },
  delivery_roles: { target: "delivery_role", personColumn: "delivery_role_id" },
  tags: { target: "tag", personColumn: null },
} as const;

export class CatalogService {
  constructor(private readonly pool: Pool) {}

  async list(actor: SessionContext, kind: CatalogKind) {
    return (
      await this.pool.query(
        `SELECT id, name, row_version AS "rowVersion"
         FROM app.${kind} WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name), id`,
        [actor.organizationId],
      )
    ).rows;
  }

  async create(actor: SessionContext, kind: CatalogKind, name: string) {
    this.requireRole(actor, structureRoles);
    return this.withNameConflict(
      this.transaction(async (client) => {
        const id = randomUUID();
        const result = await client.query(
          `INSERT INTO app.${kind} (organization_id, id, name) VALUES ($1, $2, $3)
         RETURNING id, name, row_version AS "rowVersion"`,
          [actor.organizationId, id, name.trim()],
        );
        await this.audit(
          client,
          actor,
          `${catalogConfig[kind].target}.created`,
          catalogConfig[kind].target,
          id,
        );
        return result.rows[0];
      }),
      `${catalogConfig[kind].target}_name_conflict`,
    );
  }

  async update(
    actor: SessionContext,
    kind: CatalogKind,
    id: string,
    name: string,
    rowVersion: number,
  ) {
    this.requireRole(actor, structureRoles);
    return this.withNameConflict(
      this.transaction(async (client) => {
        const result = await client.query(
          `UPDATE app.${kind} SET name = $1, row_version = row_version + 1
         WHERE organization_id = $2 AND id = $3 AND row_version = $4 AND archived_at IS NULL
         RETURNING id, name, row_version AS "rowVersion"`,
          [name.trim(), actor.organizationId, id, rowVersion],
        );
        if (!result.rows[0]) await this.missingOrStale(client, kind, actor.organizationId, id);
        await this.audit(
          client,
          actor,
          `${catalogConfig[kind].target}.updated`,
          catalogConfig[kind].target,
          id,
        );
        return result.rows[0];
      }),
      `${catalogConfig[kind].target}_name_conflict`,
    );
  }

  async archive(
    actor: SessionContext,
    kind: CatalogKind,
    id: string,
    rowVersion: number,
  ): Promise<void> {
    this.requireRole(actor, structureRoles);
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE app.${kind} SET archived_at = now(), row_version = row_version + 1
         WHERE organization_id = $1 AND id = $2 AND row_version = $3 AND archived_at IS NULL RETURNING id`,
        [actor.organizationId, id, rowVersion],
      );
      if (!result.rowCount) await this.missingOrStale(client, kind, actor.organizationId, id);
      await this.audit(
        client,
        actor,
        `${catalogConfig[kind].target}.archived`,
        catalogConfig[kind].target,
        id,
      );
    });
  }

  async listClients(actor: SessionContext) {
    return (
      await this.pool.query(
        `SELECT id, name, row_version AS "rowVersion"
         FROM app.clients WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name), id`,
        [actor.organizationId],
      )
    ).rows;
  }

  async createClient(actor: SessionContext, name: string) {
    this.requireRole(actor, planningRoles);
    return this.withNameConflict(
      this.transaction(async (client) => {
        const id = randomUUID();
        const result = await client.query(
          `INSERT INTO app.clients (organization_id, id, name) VALUES ($1, $2, $3)
         RETURNING id, name, row_version AS "rowVersion"`,
          [actor.organizationId, id, name.trim()],
        );
        await this.audit(client, actor, "client.created", "client", id);
        return result.rows[0];
      }),
      "client_name_conflict",
    );
  }

  async updateClient(actor: SessionContext, id: string, name: string, rowVersion: number) {
    this.requireRole(actor, planningRoles);
    return this.withNameConflict(
      this.transaction(async (client) => {
        const result = await client.query(
          `UPDATE app.clients SET name = $1, row_version = row_version + 1
         WHERE organization_id = $2 AND id = $3 AND row_version = $4 AND archived_at IS NULL
         RETURNING id, name, row_version AS "rowVersion"`,
          [name.trim(), actor.organizationId, id, rowVersion],
        );
        if (!result.rows[0]) await this.missingOrStale(client, "clients", actor.organizationId, id);
        await this.audit(client, actor, "client.updated", "client", id);
        return result.rows[0];
      }),
      "client_name_conflict",
    );
  }

  async archiveClient(actor: SessionContext, id: string, rowVersion: number): Promise<void> {
    this.requireRole(actor, planningRoles);
    await this.transaction(async (client) => {
      const activeProject = await client.query(
        `SELECT 1 FROM app.projects
         WHERE organization_id = $1 AND client_id = $2 AND archived_at IS NULL
           AND status NOT IN ('completed', 'cancelled') LIMIT 1`,
        [actor.organizationId, id],
      );
      if (activeProject.rowCount) throw new HttpError(409, "active_projects_reference_client");
      const result = await client.query(
        `UPDATE app.clients SET archived_at = now(), row_version = row_version + 1
         WHERE organization_id = $1 AND id = $2 AND row_version = $3 AND archived_at IS NULL RETURNING id`,
        [actor.organizationId, id, rowVersion],
      );
      if (!result.rowCount) await this.missingOrStale(client, "clients", actor.organizationId, id);
      await this.audit(client, actor, "client.archived", "client", id);
    });
  }

  private requireRole(actor: SessionContext, roles: readonly AppRole[]): void {
    if (!roles.includes(actor.role)) throw new HttpError(403, "forbidden");
  }

  private async withNameConflict<T>(operation: Promise<T>, publicCode: string): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new HttpError(409, publicCode);
      }
      throw error;
    }
  }

  private async missingOrStale(
    client: PoolClient,
    table: CatalogKind | "clients",
    organizationId: string,
    id: string,
  ): Promise<never> {
    const result = await client.query(
      `SELECT 1 FROM app.${table} WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    throw new HttpError(result.rowCount ? 409 : 404, result.rowCount ? "stale_write" : "not_found");
  }

  private async audit(
    client: PoolClient,
    actor: SessionContext,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO app.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), actor.organizationId, actor.userId, action, targetType, targetId],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
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
