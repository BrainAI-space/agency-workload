import { Pool } from "pg";
import { migrateDown, migrateUp } from "./migrate.js";
import { assertDownMigrationAllowed } from "./migration-policy.js";

const connectionString = process.env.MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error("MIGRATION_DATABASE_URL is required");
const pool = new Pool({ connectionString, max: 1 });

try {
  if (process.argv.includes("--down")) {
    assertDownMigrationAllowed(process.argv.slice(2), process.env);
    const id = await migrateDown({ pool });
    console.log(id ? "Rolled back one migration." : "No migration to roll back.");
  } else {
    const count = await migrateUp({ pool });
    console.log(`Applied ${count} migration(s).`);
  }
} finally {
  await pool.end();
}
