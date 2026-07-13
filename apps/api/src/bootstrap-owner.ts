import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { loadConfig } from "./config.js";
import { GoTrueClient } from "./gotrue-client.js";
import { normalizeEmail } from "./security.js";

const config = loadConfig();
if (!config.bootstrapEmail) throw new Error("BOOTSTRAP_EMAIL is required");
const email = normalizeEmail(config.bootstrapEmail);
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 });
const gotrue = new GoTrueClient(config.gotrueOrigin, config.gotrueServiceRoleKey);

try {
  const existing = await pool.query(
    `SELECT 1 FROM app.memberships WHERE role = 'owner' AND active LIMIT 1`,
  );
  if (existing.rowCount) {
    console.log("An active owner already exists; bootstrap made no changes.");
  } else {
    const identity = await gotrue.ensureUser(email);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext('agency-workload:owner-bootstrap'))",
      );
      const recheck = await client.query(
        `SELECT 1 FROM app.memberships WHERE role = 'owner' AND active LIMIT 1 FOR UPDATE`,
      );
      if (!recheck.rowCount) {
        const organizationId = randomUUID();
        const userId = randomUUID();
        await client.query(
          `INSERT INTO app.organizations (id, slug, name) VALUES ($1, 'agency-workload', 'Agency Workload')
           ON CONFLICT (slug) DO NOTHING`,
          [organizationId],
        );
        const organization = await client.query<{ id: string }>(
          `SELECT id FROM app.organizations WHERE slug = 'agency-workload'`,
        );
        await client.query(
          `INSERT INTO app.users (id, gotrue_user_id, email) VALUES ($1, $2, $3)
           ON CONFLICT (email) DO NOTHING`,
          [userId, identity.id, email],
        );
        const user = await client.query<{ id: string }>(
          `SELECT id FROM app.users WHERE email = $1`,
          [email],
        );
        const organizationRow = organization.rows[0];
        const userRow = user.rows[0];
        if (!organizationRow || !userRow) throw new Error("Owner bootstrap state is inconsistent");
        await client.query(
          `INSERT INTO app.memberships (organization_id, user_id, role)
           VALUES ($1, $2, 'owner') ON CONFLICT (organization_id, user_id) DO NOTHING`,
          [organizationRow.id, userRow.id],
        );
        await client.query(
          `INSERT INTO app.audit_events
           (id, organization_id, actor_user_id, action, target_type, target_id)
           VALUES ($1, $2, $3, 'owner.bootstrapped', 'user', $3)`,
          [randomUUID(), organizationRow.id, userRow.id],
        );
      }
      await client.query("COMMIT");
      console.log("Created the initial organization owner without exposing identity details.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} catch {
  console.error("Initial owner bootstrap failed without exposing identity or database details.");
  process.exitCode = 1;
} finally {
  await pool.end();
}
