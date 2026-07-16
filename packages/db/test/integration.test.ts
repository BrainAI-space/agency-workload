import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertExactPostgresIntegrationBoundary,
  runDisposablePostgresSql,
} from "../../../tools/lib/postgres-integration-boundary.mjs";
import {
  migrateDown,
  migrateUp,
  migrationChecksum,
  migrationDownChecksum,
} from "../src/migrate.js";
import { migrations } from "../src/migrations.js";

const enabled = process.env.AW_DB_INTEGRATION === "1";
if (enabled) assertExactPostgresIntegrationBoundary(process.env, "db");
const schema = `test_auth_${randomBytes(6).toString("hex")}`;
const conflictSchema = `test_conflict_${randomBytes(6).toString("hex")}`;
const upgradeSchema = `test_upgrade_${randomBytes(6).toString("hex")}`;
const legacySchema = `test_legacy_${randomBytes(6).toString("hex")}`;
const downDriftSchema = `test_down_drift_${randomBytes(6).toString("hex")}`;
const rollbackFailureSchema = `test_down_failure_${randomBytes(6).toString("hex")}`;
const newerHistorySchema = `test_history_newer_${randomBytes(6).toString("hex")}`;
const gapHistorySchema = `test_history_gap_${randomBytes(6).toString("hex")}`;
const unknownHistorySchema = `test_history_unknown_${randomBytes(6).toString("hex")}`;
const connectionString = process.env.MIGRATION_DATABASE_URL ?? "";
const pool = enabled ? new Pool({ connectionString, max: 2 }) : null;

function superuserSql(sql: string): void {
  runDisposablePostgresSql(process.env, "db", sql);
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

async function seedAppliedHistory(
  targetSchema: string,
  rows: readonly { id: string; checksum: string }[],
): Promise<void> {
  if (!pool) throw new Error("integration pool unavailable");
  await pool.query(`CREATE TABLE "${targetSchema}".schema_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL CHECK (length(checksum) = 64),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const row of rows) {
    await pool.query(
      `INSERT INTO "${targetSchema}".schema_migrations (id, checksum) VALUES ($1, $2)`,
      [row.id, row.checksum],
    );
  }
}

describe.skipIf(!enabled)("migration integration", () => {
  beforeAll(() => {
    superuserSql(`
      CREATE SCHEMA "${schema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${conflictSchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${upgradeSchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${legacySchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${downDriftSchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${rollbackFailureSchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${newerHistorySchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${gapHistorySchema}" AUTHORIZATION agency_workload_migrator;
      CREATE SCHEMA "${unknownHistorySchema}" AUTHORIZATION agency_workload_migrator;
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("migrates fresh state, preserves prior objects, and is idempotent", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    await pool.query(`CREATE TABLE "${schema}".legacy_marker (id integer PRIMARY KEY)`);
    expect(await migrateUp({ pool, schema })).toBe(9);
    expect(await migrateUp({ pool, schema })).toBe(0);
    const result = await pool.query<{
      users: string | null;
      legacy: string | null;
      down_checksums: string;
    }>(
      `SELECT to_regclass($1) AS users, to_regclass($2) AS legacy,
              (SELECT count(*)::text FROM "${schema}".schema_migrations
               WHERE down_checksum IS NOT NULL) AS down_checksums`,
      [`${schema}.users`, `${schema}.legacy_marker`],
    );
    expect(result.rows[0]?.users).toBe(`${schema}.users`);
    expect(result.rows[0]?.legacy).toBe(`${schema}.legacy_marker`);
    expect(result.rows[0]?.down_checksums).toBe("9");
  });

  it.each([
    {
      name: "newer database with older local registry",
      targetSchema: newerHistorySchema,
      applied: migrations.slice(0, 3),
      local: migrations.slice(0, 2),
    },
    {
      name: "missing middle migration",
      targetSchema: gapHistorySchema,
      applied: [migrations[0], migrations[2]].filter((migration) => migration !== undefined),
      local: migrations,
    },
    {
      name: "extra unknown migration",
      targetSchema: unknownHistorySchema,
      applied: [migrations[0], { id: "9999_unknown", up: "SELECT 1", down: "SELECT 1" }].filter(
        (migration) => migration !== undefined,
      ),
      local: migrations,
    },
  ])("refuses $name before forward or rollback SQL", async ({ targetSchema, applied, local }) => {
    if (!pool) throw new Error("integration pool unavailable");
    await seedAppliedHistory(
      targetSchema,
      applied.map((migration) => ({
        id: migration.id,
        checksum: migration.id === "9999_unknown" ? "0".repeat(64) : migrationChecksum(migration),
      })),
    );
    const expectedIds = applied.map((migration) => migration.id).sort();

    for (const operation of [
      () => migrateUp({ pool, schema: targetSchema, migrations: local }),
      () => migrateDown({ pool, schema: targetSchema, migrations: local }),
    ]) {
      await expect(operation()).rejects.toThrow(
        "Applied migration history is not an exact local prefix",
      );
    }
    const state = await pool.query<{ id: string }>(
      `SELECT id FROM "${targetSchema}".schema_migrations ORDER BY id`,
    );
    const product = await pool.query<{ users: string | null }>("SELECT to_regclass($1) AS users", [
      `${targetSchema}.users`,
    ]);
    expect(state.rows.map((row) => row.id)).toEqual(expectedIds);
    expect(product.rows[0]?.users).toBeNull();
  });

  it("rejects changed up SQL and rolls back failed migration SQL", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const firstMigration = migrations[0];
    if (!firstMigration) throw new Error("base migration unavailable");
    const changed = migrations.map((migration) =>
      migration.id === firstMigration.id
        ? { ...migration, up: `${migration.up}\nSELECT 1;` }
        : migration,
    );
    await expect(migrateUp({ pool, schema, migrations: changed })).rejects.toThrow(
      /checksum mismatch/i,
    );

    const broken = [
      ...migrations,
      {
        id: "0010_broken_recovery_probe",
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

  it("rejects changed down SQL before rollback", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    expect(await migrateUp({ pool, schema: downDriftSchema })).toBe(9);
    const latest = migrations.at(-1);
    if (!latest) throw new Error("latest migration unavailable");
    const changed = migrations.map((migration) =>
      migration.id === latest.id
        ? { ...migration, down: `${migration.down}\nSELECT 2;` }
        : migration,
    );

    await expect(migrateUp({ pool, schema: downDriftSchema, migrations: changed })).rejects.toThrow(
      `Down migration checksum mismatch: ${latest.id}`,
    );
    await expect(
      migrateDown({ pool, schema: downDriftSchema, migrations: changed }),
    ).rejects.toThrow(`Down migration checksum mismatch: ${latest.id}`);
    const state = await pool.query<{ migration: string | null; down_checksum: string | null }>(
      `SELECT id AS migration, down_checksum
       FROM "${downDriftSchema}".schema_migrations WHERE id = $1`,
      [latest.id],
    );
    expect(state.rows[0]).toEqual({
      migration: latest.id,
      down_checksum: migrationDownChecksum(latest),
    });
  });

  it("requires the forward checksum upgrade, backfills once, and preserves non-null values", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const legacyMigrations = migrations.slice(0, 8);
    expect(await migrateUp({ pool, schema: legacySchema, migrations: legacyMigrations })).toBe(8);
    await expect(
      migrateDown({ pool, schema: legacySchema, migrations: legacyMigrations }),
    ).rejects.toThrow(
      "Down migration checksum missing: 0008_forecast_horizon_v1_bounds. Run migrateUp before rollback.",
    );
    const legacyState = await pool.query<{ migration: string | null }>(
      `SELECT id AS migration FROM "${legacySchema}".schema_migrations
       WHERE id = '0008_forecast_horizon_v1_bounds'`,
    );
    expect(legacyState.rows[0]?.migration).toBe("0008_forecast_horizon_v1_bounds");

    expect(await migrateUp({ pool, schema: legacySchema })).toBe(1);
    expect(await migrateUp({ pool, schema: legacySchema })).toBe(0);
    const backfilled = await pool.query<{ id: string; down_checksum: string | null }>(
      `SELECT id, down_checksum FROM "${legacySchema}".schema_migrations ORDER BY id`,
    );
    expect(backfilled.rows).toEqual(
      migrations.map((migration) => ({
        id: migration.id,
        down_checksum: migrationDownChecksum(migration),
      })),
    );

    const firstMigration = migrations[0];
    const secondMigration = migrations[1];
    if (!firstMigration || !secondMigration) throw new Error("base migrations unavailable");
    const nonRegistryChecksum = "0".repeat(64);
    await pool.query(
      `UPDATE "${legacySchema}".schema_migrations SET down_checksum = $1 WHERE id = $2`,
      [nonRegistryChecksum, firstMigration.id],
    );
    await pool.query(
      `UPDATE "${legacySchema}".schema_migrations SET down_checksum = NULL WHERE id = $1`,
      [secondMigration.id],
    );
    const newerMigration = {
      id: "0010_forward_down_drift_probe",
      up: `CREATE TABLE {{schema}}.must_not_apply (id integer PRIMARY KEY);`,
      down: `DROP TABLE {{schema}}.must_not_apply;`,
    };
    await expect(
      migrateUp({ pool, schema: legacySchema, migrations: [...migrations, newerMigration] }),
    ).rejects.toThrow(`Down migration checksum mismatch: ${firstMigration.id}`);
    const preserved = await pool.query<{
      first_down_checksum: string | null;
      second_down_checksum: string | null;
      newer_table: string | null;
      newer_migration: string | null;
    }>(
      `SELECT
         (SELECT down_checksum FROM "${legacySchema}".schema_migrations WHERE id = $1) AS first_down_checksum,
         (SELECT down_checksum FROM "${legacySchema}".schema_migrations WHERE id = $2) AS second_down_checksum,
         to_regclass($3) AS newer_table,
         (SELECT id FROM "${legacySchema}".schema_migrations WHERE id = $4) AS newer_migration`,
      [firstMigration.id, secondMigration.id, `${legacySchema}.must_not_apply`, newerMigration.id],
    );
    expect(preserved.rows[0]).toEqual({
      first_down_checksum: nonRegistryChecksum,
      second_down_checksum: null,
      newer_table: null,
      newer_migration: null,
    });

    await pool.query(
      `UPDATE "${legacySchema}".schema_migrations SET down_checksum = NULL WHERE id = $1`,
      [firstMigration.id],
    );
    await expect(
      migrateUp({
        pool,
        schema: legacySchema,
        migrations: migrations.map((migration) =>
          migration.id === firstMigration.id
            ? { ...migration, up: `${migration.up}\nSELECT 1;` }
            : migration,
        ),
      }),
    ).rejects.toThrow(`Migration checksum mismatch: ${firstMigration.id}`);
    const refused = await pool.query<{ down_checksum: string | null }>(
      `SELECT down_checksum FROM "${legacySchema}".schema_migrations WHERE id = $1`,
      [firstMigration.id],
    );
    expect(refused.rows[0]?.down_checksum).toBeNull();
  });

  it("records new down checksums and rolls back failed down SQL atomically", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const failingDown = {
      id: "0010_failed_down_recovery_probe",
      up: `CREATE TABLE {{schema}}.rollback_probe (id integer PRIMARY KEY);
           INSERT INTO {{schema}}.rollback_probe (id) VALUES (1);`,
      down: `DELETE FROM {{schema}}.rollback_probe;
             SELECT missing_rollback_function();`,
    };
    expect(
      await migrateUp({
        pool,
        schema: rollbackFailureSchema,
        migrations: [...migrations, failingDown],
      }),
    ).toBe(10);
    const recorded = await pool.query<{ down_checksum: string | null }>(
      `SELECT down_checksum FROM "${rollbackFailureSchema}".schema_migrations WHERE id = $1`,
      [failingDown.id],
    );
    expect(recorded.rows[0]?.down_checksum).toBe(migrationDownChecksum(failingDown));

    await expect(
      migrateDown({
        pool,
        schema: rollbackFailureSchema,
        migrations: [...migrations, failingDown],
      }),
    ).rejects.toThrow(/missing_rollback_function/i);
    const state = await pool.query<{
      rows: string;
      migrations: string;
      down_checksum: string | null;
    }>(
      `SELECT
         (SELECT count(*)::text FROM "${rollbackFailureSchema}".rollback_probe) AS rows,
         (SELECT count(*)::text FROM "${rollbackFailureSchema}".schema_migrations WHERE id = $1) AS migrations,
         (SELECT down_checksum FROM "${rollbackFailureSchema}".schema_migrations WHERE id = $1) AS down_checksum`,
      [failingDown.id],
    );
    expect(state.rows[0]).toEqual({
      rows: "1",
      migrations: "1",
      down_checksum: migrationDownChecksum(failingDown),
    });
  });

  it("fails the V1 horizon upgrade without rewriting old out-of-range data", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    expect(
      await migrateUp({ pool, schema: upgradeSchema, migrations: migrations.slice(0, 7) }),
    ).toBe(7);
    const organizationId = randomUUID();
    await pool.query(
      `INSERT INTO "${upgradeSchema}".organizations (id, slug, name)
       VALUES ($1, 'upgrade', 'Upgrade')`,
      [organizationId],
    );
    await pool.query(
      `INSERT INTO "${upgradeSchema}".organization_planning_settings
       (organization_id, forecast_horizon_weeks) VALUES ($1, 12)`,
      [organizationId],
    );

    await expect(migrateUp({ pool, schema: upgradeSchema })).rejects.toThrow(/outside 13-52/i);
    const blocked = await pool.query<{ horizon: number; migration: string | null }>(
      `SELECT settings.forecast_horizon_weeks AS horizon,
              (SELECT id FROM "${upgradeSchema}".schema_migrations WHERE id = '0008_forecast_horizon_v1_bounds') AS migration
       FROM "${upgradeSchema}".organization_planning_settings settings
       WHERE settings.organization_id = $1`,
      [organizationId],
    );
    expect(blocked.rows[0]).toEqual({ horizon: 12, migration: null });

    await pool.query(
      `UPDATE "${upgradeSchema}".organization_planning_settings
       SET forecast_horizon_weeks = 13 WHERE organization_id = $1`,
      [organizationId],
    );
    expect(await migrateUp({ pool, schema: upgradeSchema })).toBe(2);
    await expect(
      pool.query(
        `UPDATE "${upgradeSchema}".organization_planning_settings
         SET forecast_horizon_weeks = 53 WHERE organization_id = $1`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
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
    const membershipStart = startAtBarrier([
      () =>
        pool.query(
          `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'member')`,
          [firstOrg, userId],
        ),
      () =>
        pool.query(
          `INSERT INTO "${schema}".memberships (organization_id, user_id, role)
         VALUES ($1, $2, 'viewer')`,
          [secondOrg, userId],
        ),
    ]);
    expect(membershipStart.issued).toBe(2);
    membershipStart.release();
    const memberships = await Promise.allSettled(membershipStart.promises);
    expect(memberships.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedMembership = memberships.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejectedMembership?.reason).toMatchObject({ code: "23505" });
    expect((rejectedMembership?.reason as { code?: string } | undefined)?.code).not.toBe("40P01");
    const pendingEmail = `pending-${randomBytes(4).toString("hex")}@example.invalid`;
    const invitationStart = startAtBarrier(
      [firstOrg, secondOrg].map(
        (organizationId) => () =>
          pool.query(
            `INSERT INTO "${schema}".invitations
           (id, organization_id, email, role, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, 'viewer', $4, $5, now() + interval '1 day')`,
            [randomUUID(), organizationId, pendingEmail, randomBytes(32), userId],
          ),
      ),
    );
    expect(invitationStart.issued).toBe(2);
    invitationStart.release();
    const invitations = await Promise.allSettled(invitationStart.promises);
    expect(invitations.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejectedInvitation = invitations.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejectedInvitation?.reason).toMatchObject({ code: "23505" });
    expect((rejectedInvitation?.reason as { code?: string } | undefined)?.code).not.toBe("40P01");
  });

  it("enforces project target-start and timezone shape constraints", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const organizationId = randomUUID();
    await pool.query(
      `INSERT INTO "${schema}".organizations (id, slug, name) VALUES ($1, $2, 'Constraints')`,
      [organizationId, `constraints-${randomBytes(4).toString("hex")}`],
    );
    await expect(
      pool.query(
        `INSERT INTO "${schema}".projects
         (organization_id, id, name, kind, status, target_end)
         VALUES ($1, $2, 'Invalid dates', 'billable', 'draft', '2030-01-31')`,
        [organizationId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO "${schema}".organization_planning_settings (organization_id, timezone)
         VALUES ($1, '../../UTC')`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO "${schema}".organization_planning_settings
         (organization_id, forecast_horizon_weeks) VALUES ($1, 12)`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `INSERT INTO "${schema}".organization_planning_settings
         (organization_id, forecast_horizon_weeks) VALUES ($1, 53)`,
        [organizationId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `INSERT INTO "${schema}".organization_planning_settings
       (organization_id, forecast_horizon_weeks) VALUES ($1, 13)`,
      [organizationId],
    );
    await expect(
      pool.query(
        `UPDATE "${schema}".organization_planning_settings
         SET forecast_horizon_weeks = 52 WHERE organization_id = $1`,
        [organizationId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("denies migration metadata access and backup writes", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const metadata = await pool.query<{
      runtime_select: boolean;
      runtime_insert: boolean;
      runtime_update: boolean;
      runtime_delete: boolean;
      runtime_truncate: boolean;
      runtime_references: boolean;
      runtime_trigger: boolean;
      backup_select: boolean;
      backup_insert: boolean;
      backup_update: boolean;
      backup_delete: boolean;
      backup_truncate: boolean;
      backup_references: boolean;
      backup_trigger: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_runtime', $1, 'SELECT') AS runtime_select,
         has_table_privilege('agency_workload_runtime', $1, 'INSERT') AS runtime_insert,
         has_table_privilege('agency_workload_runtime', $1, 'UPDATE') AS runtime_update,
         has_table_privilege('agency_workload_runtime', $1, 'DELETE') AS runtime_delete,
         has_table_privilege('agency_workload_runtime', $1, 'TRUNCATE') AS runtime_truncate,
         has_table_privilege('agency_workload_runtime', $1, 'REFERENCES') AS runtime_references,
         has_table_privilege('agency_workload_runtime', $1, 'TRIGGER') AS runtime_trigger,
         has_table_privilege('agency_workload_backup', $1, 'SELECT') AS backup_select,
         has_table_privilege('agency_workload_backup', $1, 'INSERT') AS backup_insert,
         has_table_privilege('agency_workload_backup', $1, 'UPDATE') AS backup_update,
         has_table_privilege('agency_workload_backup', $1, 'DELETE') AS backup_delete,
         has_table_privilege('agency_workload_backup', $1, 'TRUNCATE') AS backup_truncate,
         has_table_privilege('agency_workload_backup', $1, 'REFERENCES') AS backup_references,
         has_table_privilege('agency_workload_backup', $1, 'TRIGGER') AS backup_trigger`,
      [`${schema}.schema_migrations`],
    );
    expect(Object.values(metadata.rows[0] ?? {})).toEqual(Array(14).fill(false));

    const backup = await pool.query<{
      people_select: boolean;
      people_insert: boolean;
      people_update: boolean;
      people_delete: boolean;
      allocations_select: boolean;
      allocations_insert: boolean;
      allocations_update: boolean;
      allocations_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_backup', $1, 'SELECT') AS people_select,
         has_table_privilege('agency_workload_backup', $1, 'INSERT') AS people_insert,
         has_table_privilege('agency_workload_backup', $1, 'UPDATE') AS people_update,
         has_table_privilege('agency_workload_backup', $1, 'DELETE') AS people_delete,
         has_table_privilege('agency_workload_backup', $2, 'SELECT') AS allocations_select,
         has_table_privilege('agency_workload_backup', $2, 'INSERT') AS allocations_insert,
         has_table_privilege('agency_workload_backup', $2, 'UPDATE') AS allocations_update,
         has_table_privilege('agency_workload_backup', $2, 'DELETE') AS allocations_delete`,
      [`${schema}.people`, `${schema}.allocations`],
    );
    expect(backup.rows[0]).toEqual({
      people_select: true,
      people_insert: false,
      people_update: false,
      people_delete: false,
      allocations_select: true,
      allocations_insert: false,
      allocations_update: false,
      allocations_delete: false,
    });
  });

  it("enforces runtime audit grants and supports explicit rollback", async () => {
    if (!pool) throw new Error("integration pool unavailable");
    const grants = await pool.query<{
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_select_people: boolean;
      can_insert_people: boolean;
      can_update_people: boolean;
      can_delete_people: boolean;
      backup_can_read_allocations: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_runtime', $1, 'SELECT') AS can_select,
         has_table_privilege('agency_workload_runtime', $1, 'INSERT') AS can_insert,
         has_table_privilege('agency_workload_runtime', $1, 'UPDATE') AS can_update,
         has_table_privilege('agency_workload_runtime', $1, 'DELETE') AS can_delete,
         has_table_privilege('agency_workload_runtime', $2, 'SELECT') AS can_select_people,
         has_table_privilege('agency_workload_runtime', $2, 'INSERT') AS can_insert_people,
         has_table_privilege('agency_workload_runtime', $2, 'UPDATE') AS can_update_people,
         has_table_privilege('agency_workload_runtime', $2, 'DELETE') AS can_delete_people,
         has_table_privilege('agency_workload_backup', $3, 'SELECT') AS backup_can_read_allocations`,
      [`${schema}.audit_events`, `${schema}.people`, `${schema}.allocations`],
    );
    expect(grants.rows[0]).toEqual({
      can_select: true,
      can_insert: true,
      can_update: false,
      can_delete: false,
      can_select_people: true,
      can_insert_people: true,
      can_update_people: true,
      can_delete_people: true,
      backup_can_read_allocations: true,
    });

    await pool.query(`CREATE TABLE "${schema}".single_privilege_probe (id integer)`);
    await pool.query(
      `REVOKE ALL ON "${schema}".single_privilege_probe FROM agency_workload_runtime;
       GRANT SELECT ON "${schema}".single_privilege_probe TO agency_workload_runtime`,
    );
    const singlePrivilege = await pool.query<{
      combined_any: boolean;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_runtime', $1, 'SELECT,INSERT,UPDATE,DELETE') AS combined_any,
         has_table_privilege('agency_workload_runtime', $1, 'SELECT') AS can_select,
         has_table_privilege('agency_workload_runtime', $1, 'INSERT') AS can_insert,
         has_table_privilege('agency_workload_runtime', $1, 'UPDATE') AS can_update,
         has_table_privilege('agency_workload_runtime', $1, 'DELETE') AS can_delete`,
      [`${schema}.single_privilege_probe`],
    );
    expect(singlePrivilege.rows[0]).toEqual({
      combined_any: true,
      can_select: true,
      can_insert: false,
      can_update: false,
      can_delete: false,
    });
    expect(
      [
        singlePrivilege.rows[0]?.can_select,
        singlePrivilege.rows[0]?.can_insert,
        singlePrivilege.rows[0]?.can_update,
        singlePrivilege.rows[0]?.can_delete,
      ].every(Boolean),
    ).toBe(false);
    await pool.query(`DROP TABLE "${schema}".single_privilege_probe`);

    expect(await migrateDown({ pool, schema })).toBe("0009_down_migration_checksums");
    expect(await migrateDown({ pool, schema })).toBe("0008_forecast_horizon_v1_bounds");
    const horizonConstraints = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_constraint
       WHERE conrelid = $1::regclass AND conname LIKE 'organization_planning_settings_forecast_horizon%'`,
      [`${schema}.organization_planning_settings`],
    );
    expect(horizonConstraints.rows[0]?.count).toBe("1");
    const rollbackOrganizationId = randomUUID();
    await pool.query(
      `INSERT INTO "${schema}".organizations (id, slug, name)
       VALUES ($1, $2, 'Rollback Bounds')`,
      [rollbackOrganizationId, `rollback-${randomBytes(4).toString("hex")}`],
    );
    await pool.query(
      `INSERT INTO "${schema}".organization_planning_settings
       (organization_id, forecast_horizon_weeks) VALUES ($1, 1)`,
      [rollbackOrganizationId],
    );
    await expect(
      pool.query(
        `UPDATE "${schema}".organization_planning_settings
         SET forecast_horizon_weeks = 104 WHERE organization_id = $1`,
        [rollbackOrganizationId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    for (const invalid of [0, 105]) {
      await expect(
        pool.query(
          `UPDATE "${schema}".organization_planning_settings
           SET forecast_horizon_weeks = $1 WHERE organization_id = $2`,
          [invalid, rollbackOrganizationId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(await migrateDown({ pool, schema })).toBe(
      "0007_holiday_calendar_active_name_uniqueness",
    );
    expect(await migrateDown({ pool, schema })).toBe(
      "0006_catalog_versions_and_single_holiday_calendar",
    );
    expect(await migrateDown({ pool, schema })).toBe("0005_project_states_dates_and_timezones");
    expect(await migrateDown({ pool, schema })).toBe("0004_planning_domain_core");
    expect(await migrateDown({ pool, schema })).toBe(
      "0003_single_organization_and_invitation_delivery",
    );
    expect(await migrateDown({ pool, schema })).toBe("0002_email_control_character_checks");
    expect(await migrateDown({ pool, schema })).toBe("0001_identity_sessions_admin");
    const state = await pool.query<{
      users: string | null;
      legacy: string | null;
      app_schema: string | null;
    }>(
      `SELECT to_regclass($1) AS users, to_regclass($2) AS legacy,
              to_regnamespace($3) AS app_schema`,
      [`${schema}.users`, `${schema}.legacy_marker`, schema],
    );
    expect(state.rows[0]?.users).toBeNull();
    expect(state.rows[0]?.legacy).toBe(`${schema}.legacy_marker`);
    expect(state.rows[0]?.app_schema).toBe(schema);

    const revoked = await pool.query<{
      runtime_schema_usage: boolean;
      backup_schema_usage: boolean;
      runtime_select: boolean;
      runtime_insert: boolean;
      runtime_update: boolean;
      runtime_delete: boolean;
      backup_select: boolean;
      backup_insert: boolean;
      backup_update: boolean;
      backup_delete: boolean;
    }>(
      `SELECT
         has_schema_privilege('agency_workload_runtime', $1, 'USAGE') AS runtime_schema_usage,
         has_schema_privilege('agency_workload_backup', $1, 'USAGE') AS backup_schema_usage,
         has_table_privilege('agency_workload_runtime', $2, 'SELECT') AS runtime_select,
         has_table_privilege('agency_workload_runtime', $2, 'INSERT') AS runtime_insert,
         has_table_privilege('agency_workload_runtime', $2, 'UPDATE') AS runtime_update,
         has_table_privilege('agency_workload_runtime', $2, 'DELETE') AS runtime_delete,
         has_table_privilege('agency_workload_backup', $2, 'SELECT') AS backup_select,
         has_table_privilege('agency_workload_backup', $2, 'INSERT') AS backup_insert,
         has_table_privilege('agency_workload_backup', $2, 'UPDATE') AS backup_update,
         has_table_privilege('agency_workload_backup', $2, 'DELETE') AS backup_delete`,
      [schema, `${schema}.legacy_marker`],
    );
    expect(Object.values(revoked.rows[0] ?? {}).every((value) => value === false)).toBe(true);

    await pool.query(`CREATE TABLE "${schema}".post_rollback_table (id integer PRIMARY KEY)`);
    const postRollback = await pool.query<{
      runtime_select: boolean;
      runtime_insert: boolean;
      runtime_update: boolean;
      runtime_delete: boolean;
      backup_select: boolean;
      backup_insert: boolean;
      backup_update: boolean;
      backup_delete: boolean;
    }>(
      `SELECT
         has_table_privilege('agency_workload_runtime', $1, 'SELECT') AS runtime_select,
         has_table_privilege('agency_workload_runtime', $1, 'INSERT') AS runtime_insert,
         has_table_privilege('agency_workload_runtime', $1, 'UPDATE') AS runtime_update,
         has_table_privilege('agency_workload_runtime', $1, 'DELETE') AS runtime_delete,
         has_table_privilege('agency_workload_backup', $1, 'SELECT') AS backup_select,
         has_table_privilege('agency_workload_backup', $1, 'INSERT') AS backup_insert,
         has_table_privilege('agency_workload_backup', $1, 'UPDATE') AS backup_update,
         has_table_privilege('agency_workload_backup', $1, 'DELETE') AS backup_delete`,
      [`${schema}.post_rollback_table`],
    );
    expect(Object.values(postRollback.rows[0] ?? {}).every((value) => value === false)).toBe(true);
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
