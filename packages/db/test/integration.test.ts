import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDown, migrateUp } from "../src/migrate.js";
import { migrations } from "../src/migrations.js";

const enabled = process.env.AW_DB_INTEGRATION === "1";
const schema = `test_auth_${randomBytes(6).toString("hex")}`;
const conflictSchema = `test_conflict_${randomBytes(6).toString("hex")}`;
const connectionString = process.env.MIGRATION_DATABASE_URL ?? "";
const pool = enabled ? new Pool({ connectionString, max: 2 }) : null;

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
    throw new Error("Isolated database test setup failed without exposing subprocess output");
  }
}

describe.skipIf(!enabled)("migration integration", () => {
  beforeAll(() => {
    superuserSql(`
      CREATE SCHEMA "${schema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${conflictSchema}" AUTHORIZATION agency_workload_migrator;
    `);
  });

  afterAll(async () => {
    await pool?.end();
    superuserSql(`DROP SCHEMA IF EXISTS "${schema}" CASCADE;`);
    superuserSql(`DROP SCHEMA IF EXISTS "${conflictSchema}" CASCADE;`);
  });

  it("migrates fresh state, preserves prior objects, and is idempotent", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    await pool.query(`CREATE TABLE "${schema}".legacy_marker (id integer PRIMARY KEY)`);
    expect(await migrateUp({ pool, schema })).toBe(3);
    expect(await migrateUp({ pool, schema })).toBe(0);
    const result = await pool.query<{ users: string | null; legacy: string | null }>(
      `SELECT to_regclass($1) AS users, to_regclass($2) AS legacy`,
      [`${schema}.users`, `${schema}.legacy_marker`],
    );
    expect(result.rows[0]?.users).toBe(`${schema}.users`);
    expect(result.rows[0]?.legacy).toBe(`${schema}.legacy_marker`);
  });

  it("rejects checksum drift and rolls back failed migration SQL", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const firstMigration = migrations[0];
    if (!firstMigration) throw new Error("base migration unavailable");
    const changed = [{ ...firstMigration, up: `${firstMigration.up}\nSELECT 1;` }];
    await expect(migrateUp({ pool, schema, migrations: changed })).rejects.toThrow(
      /checksum mismatch/i,
    );

    const broken = [
      ...migrations,
      {
        id: "0004_broken_recovery_probe",
        up: `CREATE TABLE {{schema}}.must_rollback (id integer); SELECT missing_function();`,
        down: `DROP TABLE IF EXISTS {{schema}}.must_rollback`,
      },
    ];
    await expect(migrateUp({ pool, schema, migrations: broken })).rejects.toThrow();
    const recovery = await pool.query<{ table_name: string | null }>(
      `SELECT to_regclass($1) AS table_name`,
      [`${schema}.must_rollback`],
    );
    expect(recovery.rows[0]?.table_name).toBeNull();
  });

  it("serializes cross-organization active memberships and pending invitations", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const firstOrg = randomUUID();
    const secondOrg = randomUUID();
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO "${schema}".organizations (id, slug, name)
       VALUES ($1, $3, 'First'), ($2, $4, 'Second')`,
      [
        firstOrg,
        secondOrg,
        `first-${randomBytes(4).toString("hex")}`,
        `second-${randomBytes(4).toString("hex")}`,
      ],
    );
    await pool.query(
      `INSERT INTO "${schema}".users (id, gotrue_user_id, email)
       VALUES ($1, $2, $3)`,
      [userId, randomUUID(), `single-${randomBytes(4).toString("hex")}@example.invalid`],
    );
    const memberships = await Promise.allSettled([
      pool.query(
        `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'member')`,
        [firstOrg, userId],
      ),
      pool.query(
        `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'viewer')`,
        [secondOrg, userId],
      ),
    ]);
    expect(memberships.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const pendingEmail = `pending-${randomBytes(4).toString("hex")}@example.invalid`;
    const invitations = await Promise.allSettled(
      [firstOrg, secondOrg].map((organizationId) =>
        pool.query(
          `INSERT INTO "${schema}".invitations
           (id, organization_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, 'viewer', $4, $5, now() + interval '1 day')`,
          [randomUUID(), organizationId, pendingEmail, randomBytes(32), userId],
        ),
      ),
    );
    expect(invitations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("enforces runtime audit grants and supports explicit rollback", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const grants = await pool.query<{
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_runtime', $1, 'INSERT') AS can_insert,
         has_table_privilege('agency_workload_runtime', $1, 'UPDATE') AS can_update,
         has_table_privilege('agency_workload_runtime', $1, 'DELETE') AS can_delete`,
      [`${schema}.audit_events`],
    );
    expect(grants.rows[0]).toEqual({ can_insert: true, can_update: false, can_delete: false });
    expect(await migrateDown({ pool, schema })).toBe(
      "0003_single_organization_and_invitation_delivery",
    );
    expect(await migrateDown({ pool, schema })).toBe("0002_email_control_character_checks");
    expect(await migrateDown({ pool, schema })).toBe("0001_identity_sessions_admin");
    const state = await pool.query<{ users: string | null; legacy: string | null }>(
      `SELECT to_regclass($1) AS users, to_regclass($2) AS legacy`,
      [`${schema}.users`, `${schema}.legacy_marker`],
    );
    expect(state.rows[0]?.users).toBeNull();
    expect(state.rows[0]?.legacy).toBe(`${schema}.legacy_marker`);
  });

  it("reports pre-existing single-organization conflicts without deleting rows", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    expect(
      await migrateUp({ pool, schema: conflictSchema, migrations: migrations.slice(0, 2) }),
    ).toBe(2);
    const firstOrg = randomUUID();
    const secondOrg = randomUUID();
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO "${conflictSchema}".organizations (id, slug, name)
       VALUES ($1, 'first', 'First'), ($2, 'second', 'Second')`,
      [firstOrg, secondOrg],
    );
    await pool.query(
      `INSERT INTO "${conflictSchema}".users (id, gotrue_user_id, email)
       VALUES ($1, $2, 'conflict@example.invalid')`,
      [userId, randomUUID()],
    );
    await pool.query(
      `INSERT INTO "${conflictSchema}".memberships (organization_id, user_id, role)
       VALUES ($1, $3, 'member'), ($2, $3, 'viewer')`,
      [firstOrg, secondOrg, userId],
    );
    for (const organizationId of [firstOrg, secondOrg]) {
      await pool.query(
        `INSERT INTO "${conflictSchema}".invitations
         (id, organization_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1, $2, 'pending@example.invalid', 'viewer', $3, $4, now() + interval '1 day')`,
        [randomUUID(), organizationId, randomBytes(32), userId],
      );
    }
    await expect(migrateUp({ pool, schema: conflictSchema })).rejects.toThrow(
      /multiple active memberships/i,
    );
    await pool.query(
      `UPDATE "${conflictSchema}".memberships SET active = false WHERE organization_id = $1`,
      [secondOrg],
    );
    await expect(migrateUp({ pool, schema: conflictSchema })).rejects.toThrow(
      /multiple pending invitations/i,
    );
    const counts = await pool.query<{ memberships: string; invitations: string }>(
      `SELECT
        (SELECT count(*)::text FROM "${conflictSchema}".memberships) AS memberships,
        (SELECT count(*)::text FROM "${conflictSchema}".invitations) AS invitations`,
    );
    expect(counts.rows[0]).toEqual({ memberships: "2", invitations: "2" });
  });
});
