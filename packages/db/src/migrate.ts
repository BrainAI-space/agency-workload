import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { migrations as defaultMigrations, type SqlMigration } from "./migrations.js";

const identifierPattern = /^[a-z_][a-z0-9_]{0,62}$/;

export function migrationChecksum(migration: SqlMigration): string {
  return createHash("sha256").update(migration.id).update("\0").update(migration.up).digest("hex");
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
    const checksums = new Map(existing.rows.map((row) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const checksum = migrationChecksum(migration);
      const recorded = checksums.get(migration.id);
      if (recorded && recorded !== checksum)
        throw new Error(`Migration checksum mismatch: ${migration.id}`);
      if (recorded) continue;
      await client.query("BEGIN");
      try {
        await client.query(render(migration.up, schema));
        await client.query(
          `INSERT INTO "${schema}".schema_migrations (id, checksum) VALUES ($1, $2)`,
          [migration.id, checksum],
        );
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
      `SELECT id, checksum FROM "${schema}".schema_migrations ORDER BY id DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    const migration = migrations.find((candidate) => candidate.id === row.id);
    if (!migration || migrationChecksum(migration) !== row.checksum) {
      throw new Error(`Migration checksum mismatch: ${row.id}`);
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
