import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { migrations as defaultMigrations, type SqlMigration } from "./migrations.js";

const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;

export function migrationChecksum(migration: SqlMigration): string {
  return createHash("sha256").update(migration.id).update("\0").update(migration.up).digest("hex");
}

export function migrationDownChecksum(migration: SqlMigration): string {
  return createHash("sha256")
    .update(migration.id)
    .update("\0")
    .update(migration.down)
    .digest("hex");
}

export function assertAppliedMigrationHistory(
  appliedIds: readonly string[],
  migrations: readonly SqlMigration[],
): void {
  if (
    appliedIds.length > migrations.length ||
    appliedIds.some((id, index) => id !== migrations[index]?.id)
  ) {
    throw new Error("Applied migration history is not an exact local prefix");
  }
}

function render(sql: string, schema: string): string {
  if (!identifierPattern.test(schema)) throw new Error("Invalid migration schema");
  return sql.replaceAll("{{schema}}", `"${schema}"`);
}

async function ensureMetadata(client: PoolClient, schema: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS "${schema}".schema_migrations (
    id text PRIMARY KEY,
    checksum text NOT NULL CHECK (length(checksum) = 64),
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
}

async function hasDownChecksumColumn(client: PoolClient, schema: string): Promise<boolean> {
  const result = await client.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'schema_migrations'
         AND column_name = 'down_checksum'
     ) AS present`,
    [schema],
  );
  return result.rows[0]?.present === true;
}

async function backfillMissingDownChecksums(
  client: PoolClient,
  schema: string,
  migrations: readonly SqlMigration[],
): Promise<void> {
  if (migrations.length === 0) return;
  const values = migrations
    .map((_migration, index) => `($${index * 2 + 1}::text, $${index * 2 + 2}::text)`)
    .join(", ");
  const parameters = migrations.flatMap((migration) => [
    migration.id,
    migrationDownChecksum(migration),
  ]);
  await client.query(
    `UPDATE "${schema}".schema_migrations AS applied
     SET down_checksum = registry.down_checksum
     FROM (VALUES ${values}) AS registry(id, down_checksum)
     WHERE applied.id = registry.id AND applied.down_checksum IS NULL`,
    parameters,
  );
}

export interface MigrationOptions {
  pool: Pool;
  schema?: string;
  migrations?: readonly SqlMigration[];
}

export async function migrateUp({
  pool,
  schema = "app",
  migrations = defaultMigrations,
}: MigrationOptions): Promise<number> {
  if (!identifierPattern.test(schema)) throw new Error("Invalid migration schema");
  const client = await pool.connect();
  let applied = 0;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`agency-workload:${schema}`]);
    await ensureMetadata(client, schema);
    const existing = await client.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM "${schema}".schema_migrations ORDER BY id`,
    );
    assertAppliedMigrationHistory(
      existing.rows.map((row) => row.id),
      migrations,
    );
    const checksums = new Map(existing.rows.map((row) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const recorded = checksums.get(migration.id);
      if (recorded && recorded !== migrationChecksum(migration)) {
        throw new Error(`Migration checksum mismatch: ${migration.id}`);
      }
    }

    let supportsDownChecksums = await hasDownChecksumColumn(client, schema);
    if (supportsDownChecksums) {
      const recordedDownChecksums = await client.query<{
        id: string;
        down_checksum: string | null;
      }>(`SELECT id, down_checksum FROM "${schema}".schema_migrations ORDER BY id`);
      for (const [index, row] of recordedDownChecksums.rows.entries()) {
        const migration = migrations[index];
        if (
          migration &&
          row.down_checksum !== null &&
          row.down_checksum !== migrationDownChecksum(migration)
        ) {
          throw new Error(`Down migration checksum mismatch: ${row.id}`);
        }
      }
      await client.query("BEGIN");
      try {
        await backfillMissingDownChecksums(client, schema, migrations);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const recorded = checksums.get(migration.id);
      if (recorded) continue;
      await client.query("BEGIN");
      try {
        await client.query(render(migration.up, schema));
        supportsDownChecksums = await hasDownChecksumColumn(client, schema);
        if (supportsDownChecksums) {
          await client.query(
            `INSERT INTO "${schema}".schema_migrations (id, checksum, down_checksum)
             VALUES ($1, $2, $3)`,
            [migration.id, checksum, migrationDownChecksum(migration)],
          );
          await backfillMissingDownChecksums(client, schema, migrations);
        } else {
          await client.query(
            `INSERT INTO "${schema}".schema_migrations (id, checksum) VALUES ($1, $2)`,
            [migration.id, checksum],
          );
        }
        await client.query("COMMIT");
        applied += 1;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [`agency-workload:${schema}`])
      .catch(() => undefined);
    client.release();
  }
}

export async function migrateDown({
  pool,
  schema = "app",
  migrations = defaultMigrations,
}: MigrationOptions): Promise<string | null> {
  if (!identifierPattern.test(schema)) throw new Error("Invalid migration schema");
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [`agency-workload:${schema}`]);
    await ensureMetadata(client, schema);
    const result = await client.query<{ id: string; checksum: string }>(
      `SELECT id, checksum FROM "${schema}".schema_migrations ORDER BY id`,
    );
    assertAppliedMigrationHistory(
      result.rows.map((row) => row.id),
      migrations,
    );
    const row = result.rows.at(-1);
    if (!row) return null;
    const migration = migrations[result.rows.length - 1];
    if (!migration || migrationChecksum(migration) !== row.checksum) {
      throw new Error(`Migration checksum mismatch: ${row.id}`);
    }
    if (!(await hasDownChecksumColumn(client, schema))) {
      throw new Error(`Down migration checksum missing: ${row.id}. Run migrateUp before rollback.`);
    }
    const downChecksum = await client.query<{ down_checksum: string | null }>(
      `SELECT down_checksum FROM "${schema}".schema_migrations WHERE id = $1`,
      [row.id],
    );
    const recordedDownChecksum = downChecksum.rows[0]?.down_checksum;
    if (!recordedDownChecksum) {
      throw new Error(`Down migration checksum missing: ${row.id}. Run migrateUp before rollback.`);
    }
    if (migrationDownChecksum(migration) !== recordedDownChecksum) {
      throw new Error(`Down migration checksum mismatch: ${row.id}`);
    }
    await client.query("BEGIN");
    try {
      await client.query(render(migration.down, schema));
      await client.query(`DELETE FROM "${schema}".schema_migrations WHERE id = $1`, [row.id]);
      await client.query("COMMIT");
      return row.id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client
      .query("SELECT pg_advisory_unlock(hashtext($1))", [`agency-workload:${schema}`])
      .catch(() => undefined);
    client.release();
  }
}
