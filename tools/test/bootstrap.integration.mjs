import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bootstrapLocal } from "../lib/bootstrap.mjs";

if (!process.argv.includes("--integration")) {
  console.error("Refusing database mutation without the explicit --integration flag.");
  process.exit(1);
}

const root = fileURLToPath(new URL("../..", import.meta.url));
await bootstrapLocal({ root });

const migration = spawnSync(
  process.execPath,
  ["--env-file=.env", "--import", "tsx", "packages/db/src/cli.ts"],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  },
);
if (migration.error || migration.status !== 0) {
  console.error("Bootstrap integration migration failed without exposing subprocess output.");
  process.exit(1);
}

await bootstrapLocal({ root });

const verificationSql = String.raw`
\set ON_ERROR_STOP on
DO $verify$
DECLARE
  privilege_name text;
  role_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_database database
    JOIN pg_roles owner_role ON owner_role.oid = database.datdba
    WHERE database.datname = 'agency_workload'
      AND owner_role.rolname = 'agency_workload_owner'
  ) THEN
    RAISE EXCEPTION 'database ownership verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'agency_workload_owner'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'owner role verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'postgres'
      AND NOT rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
      AND NOT rolreplication
  ) THEN
    RAISE EXCEPTION 'GoTrue compatibility role verification failed';
  END IF;

  FOREACH role_name IN ARRAY ARRAY[
    'agency_workload_migrator',
    'agency_workload_runtime',
    'supabase_auth_admin',
    'agency_workload_backup'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_roles
      WHERE rolname = role_name
        AND rolcanlogin AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
        AND NOT rolreplication
    ) THEN
      RAISE EXCEPTION 'login role verification failed for %', role_name;
    END IF;
  END LOOP;

  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'app')
      IS DISTINCT FROM 'agency_workload_owner' THEN
    RAISE EXCEPTION 'app schema ownership verification failed';
  END IF;
  IF (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'auth')
      IS DISTINCT FROM 'supabase_auth_admin' THEN
    RAISE EXCEPTION 'auth schema ownership verification failed';
  END IF;

  IF has_schema_privilege('agency_workload_runtime', 'public', 'USAGE')
      OR has_schema_privilege('agency_workload_runtime', 'public', 'CREATE')
      OR has_schema_privilege('agency_workload_runtime', 'auth', 'USAGE')
      OR NOT has_schema_privilege('agency_workload_runtime', 'app', 'USAGE')
      OR has_schema_privilege('agency_workload_runtime', 'app', 'CREATE') THEN
    RAISE EXCEPTION 'runtime schema privilege verification failed';
  END IF;

  IF NOT has_schema_privilege('agency_workload_migrator', 'app', 'USAGE')
      OR NOT has_schema_privilege('agency_workload_migrator', 'app', 'CREATE')
      OR has_schema_privilege('agency_workload_migrator', 'auth', 'USAGE') THEN
    RAISE EXCEPTION 'migrator schema privilege verification failed';
  END IF;

  IF NOT has_schema_privilege('supabase_auth_admin', 'auth', 'USAGE')
      OR NOT has_schema_privilege('supabase_auth_admin', 'auth', 'CREATE')
      OR has_schema_privilege('supabase_auth_admin', 'app', 'USAGE') THEN
    RAISE EXCEPTION 'auth schema privilege verification failed';
  END IF;

  IF NOT has_schema_privilege('agency_workload_backup', 'app', 'USAGE')
      OR NOT has_schema_privilege('agency_workload_backup', 'auth', 'USAGE')
      OR has_schema_privilege('agency_workload_backup', 'app', 'CREATE')
      OR has_schema_privilege('agency_workload_backup', 'auth', 'CREATE') THEN
    RAISE EXCEPTION 'backup schema privilege verification failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM aclexplode((SELECT datacl FROM pg_database WHERE datname = 'agency_workload'))
    WHERE grantee = 0 AND privilege_type IN ('CONNECT', 'CREATE', 'TEMPORARY')
  ) THEN
    RAISE EXCEPTION 'PUBLIC database privilege verification failed';
  END IF;

  IF to_regclass('app.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'migration metadata table verification failed';
  END IF;
  FOREACH role_name IN ARRAY ARRAY[
    'agency_workload_runtime',
    'agency_workload_backup'
  ] LOOP
    FOREACH privilege_name IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ] LOOP
      IF has_table_privilege(role_name, 'app.schema_migrations', privilege_name) THEN
        RAISE EXCEPTION 'migration metadata privilege verification failed for % %',
          role_name, privilege_name;
      END IF;
    END LOOP;
  END LOOP;

  IF NOT has_table_privilege('agency_workload_runtime', 'app.organizations', 'SELECT')
      OR NOT has_table_privilege('agency_workload_runtime', 'app.organizations', 'INSERT')
      OR NOT has_table_privilege('agency_workload_runtime', 'app.organizations', 'UPDATE')
      OR NOT has_table_privilege('agency_workload_runtime', 'app.organizations', 'DELETE')
      OR NOT has_table_privilege('agency_workload_backup', 'app.organizations', 'SELECT')
      OR has_table_privilege('agency_workload_backup', 'app.organizations', 'INSERT')
      OR has_table_privilege('agency_workload_backup', 'app.organizations', 'UPDATE')
      OR has_table_privilege('agency_workload_backup', 'app.organizations', 'DELETE') THEN
    RAISE EXCEPTION 'normal application table privilege verification failed';
  END IF;

  IF NOT has_table_privilege('agency_workload_runtime', 'app.audit_events', 'SELECT')
      OR NOT has_table_privilege('agency_workload_runtime', 'app.audit_events', 'INSERT')
      OR has_table_privilege('agency_workload_runtime', 'app.audit_events', 'UPDATE')
      OR has_table_privilege('agency_workload_runtime', 'app.audit_events', 'DELETE') THEN
    RAISE EXCEPTION 'append-only audit privilege verification failed';
  END IF;
END
$verify$;
`;

const result = spawnSync(
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
  { encoding: "utf8", input: verificationSql, windowsHide: true },
);

if (result.error || result.status !== 0) {
  console.error("Bootstrap integration verification failed without exposing subprocess output.");
  process.exit(1);
}

console.log(
  "Verified bootstrap before migration and after migration without metadata or audit ACL regression.",
);
