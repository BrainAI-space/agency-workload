import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalAuthTargetManifest,
  createAuthTargetProof,
} from "./auth-integration-boundary.mjs";
import { createServiceRoleToken } from "./config.mjs";

const suffixPattern = /^[a-f0-9]{32}$/;
const databasePattern = /^agency_workload_smoke_[a-f0-9]{32}$/;
const composePattern = /^agency-workload-smoke-[a-f0-9]{32}$/;
const emailPattern = /^smoke-owner-[a-f0-9]{32}@agency-workload\.local$/;
export const PERSISTENT_LOCAL_PORTS = Object.freeze([1025, 3100, 4100, 5432, 5434, 8025, 9999]);
const systemEnvironmentKeys = Object.freeze([
  "APPDATA",
  "ComSpec",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "Path",
  "PLAYWRIGHT_BROWSERS_PATH",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "WINDIR",
  "XDG_CACHE_HOME",
]);

const roles = Object.freeze({
  owner: "agency_workload_owner",
  migrator: "agency_workload_migrator",
  runtime: "agency_workload_runtime",
  auth: "supabase_auth_admin",
  backup: "agency_workload_backup",
});

function randomSecret(label, randomBytes) {
  return createHash("sha256").update(label).update(randomBytes(32)).digest("base64url");
}

function databaseUrl(username, password, hostname, port, databaseName) {
  const url = new URL(`postgresql://${username}@${hostname}:${port}/${databaseName}`);
  url.password = password;
  return url.toString();
}

function systemEnvironment(environment) {
  const result = {};
  for (const key of systemEnvironmentKeys) {
    if (typeof environment[key] === "string" && environment[key]) result[key] = environment[key];
  }
  return result;
}

function dockerSystemEnvironment(environment) {
  const result = systemEnvironment(environment);
  if (typeof environment.DOCKER_CONFIG === "string" && environment.DOCKER_CONFIG) {
    result.DOCKER_CONFIG = environment.DOCKER_CONFIG;
  }
  result.COMPOSE_DISABLE_ENV_FILE = "true";
  return result;
}

function childEnvironment(system, values) {
  return Object.freeze({ ...system, ...values });
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function generateSmokeSuffix(randomBytes = nodeRandomBytes) {
  const suffix = randomBytes(16).toString("hex");
  if (!suffixPattern.test(suffix)) throw new Error("Browser smoke suffix generation failed");
  return suffix;
}

export function createSmokeIdentity(suffix) {
  if (typeof suffix !== "string" || !suffixPattern.test(suffix)) {
    throw new Error("Browser smoke suffix is unsafe");
  }
  const composeProject = `agency-workload-smoke-${suffix}`;
  const identity = {
    suffix,
    databaseName: `agency_workload_smoke_${suffix}`,
    bootstrapEmail: `smoke-owner-${suffix}@agency-workload.local`,
    composeProject,
    containers: Object.freeze({
      postgres: `${composeProject}-postgres-1`,
      gotrue: `${composeProject}-gotrue-1`,
      mailpit: `${composeProject}-mailpit-1`,
    }),
    networkName: `${composeProject}_private`,
    hostNetworkName: `${composeProject}_host-access`,
    processMarkers: Object.freeze({
      api: `${composeProject}-api`,
      auth: `${composeProject}-auth`,
      browser: `${composeProject}-browser`,
      web: `${composeProject}-web`,
    }),
    volumeName: `${composeProject}_postgres-data`,
  };
  assertSmokeIdentity(identity);
  return Object.freeze(identity);
}

export function assertSmokeIdentity(identity) {
  if (!identity || typeof identity !== "object" || !suffixPattern.test(identity.suffix ?? "")) {
    throw new Error("Browser smoke suffix is unsafe");
  }
  if (
    !databasePattern.test(identity.databaseName ?? "") ||
    identity.databaseName !== `agency_workload_smoke_${identity.suffix}`
  ) {
    throw new Error("Browser smoke database identifier is unsafe");
  }
  if (
    !composePattern.test(identity.composeProject ?? "") ||
    identity.composeProject !== `agency-workload-smoke-${identity.suffix}`
  ) {
    throw new Error("Browser smoke Compose identifier is unsafe");
  }
  if (
    !emailPattern.test(identity.bootstrapEmail ?? "") ||
    identity.bootstrapEmail !== `smoke-owner-${identity.suffix}@agency-workload.local`
  ) {
    throw new Error("Browser smoke bootstrap email is unsafe");
  }
  const expected = {
    postgres: `${identity.composeProject}-postgres-1`,
    gotrue: `${identity.composeProject}-gotrue-1`,
    mailpit: `${identity.composeProject}-mailpit-1`,
    network: `${identity.composeProject}_private`,
    hostNetwork: `${identity.composeProject}_host-access`,
    apiMarker: `${identity.composeProject}-api`,
    authMarker: `${identity.composeProject}-auth`,
    browserMarker: `${identity.composeProject}-browser`,
    webMarker: `${identity.composeProject}-web`,
    volume: `${identity.composeProject}_postgres-data`,
  };
  if (
    identity.containers?.postgres !== expected.postgres ||
    identity.containers?.gotrue !== expected.gotrue ||
    identity.containers?.mailpit !== expected.mailpit ||
    identity.networkName !== expected.network ||
    identity.hostNetworkName !== expected.hostNetwork ||
    identity.processMarkers?.api !== expected.apiMarker ||
    identity.processMarkers?.auth !== expected.authMarker ||
    identity.processMarkers?.browser !== expected.browserMarker ||
    identity.processMarkers?.web !== expected.webMarker ||
    identity.volumeName !== expected.volume
  ) {
    throw new Error("Browser smoke generated resource names are unsafe");
  }
}

export function persistentPortExclusions() {
  return new Set(PERSISTENT_LOCAL_PORTS);
}

export function assertDisposablePorts(ports, persistentPorts) {
  const values = ["postgres", "web", "api", "gotrue", "smtp", "mailpit"].map((key) => ports?.[key]);
  if (values.some((port) => !Number.isSafeInteger(port) || port < 1024 || port > 65_535)) {
    throw new Error("Browser smoke port is invalid");
  }
  if (new Set(values).size !== values.length) {
    throw new Error("Browser smoke ports must be unique");
  }
  if (values.some((port) => persistentPorts.has(port))) {
    throw new Error("Browser smoke port collides with a persistent service");
  }
}

export function createSmokeConfiguration(
  identity,
  ports,
  { now = Math.floor(Date.now() / 1000), randomBytes = nodeRandomBytes } = {},
) {
  assertSmokeIdentity(identity);
  assertDisposablePorts(ports, persistentPortExclusions());
  const postgresPassword = randomSecret("postgres", randomBytes);
  const migratorPassword = randomSecret("migrator", randomBytes);
  const runtimePassword = randomSecret("runtime", randomBytes);
  const authPassword = randomSecret("auth", randomBytes);
  const backupPassword = randomSecret("backup", randomBytes);
  const gotrueJwtSecret = randomSecret("gotrue-jwt", randomBytes);
  const sessionSecret = randomSecret("session", randomBytes);
  const appOrigin = `http://localhost:${ports.web}`;
  const apiOrigin = `http://localhost:${ports.api}`;
  const gotrueOrigin = `http://127.0.0.1:${ports.gotrue}`;
  const mailpitOrigin = `http://127.0.0.1:${ports.mailpit}`;
  return Object.freeze({
    appOrigin,
    apiOrigin,
    authPassword,
    backupPassword,
    browserProfileDirectory: join(tmpdir(), `${identity.processMarkers.browser}-profile`),
    bootstrapEmail: identity.bootstrapEmail,
    databaseName: identity.databaseName,
    gotrueDatabaseUrl: databaseUrl(
      roles.auth,
      authPassword,
      "postgres",
      5432,
      identity.databaseName,
    ),
    gotrueHostDatabaseUrl: databaseUrl(
      roles.auth,
      authPassword,
      "127.0.0.1",
      ports.postgres,
      identity.databaseName,
    ),
    gotrueJwtSecret,
    gotrueOrigin,
    gotrueServiceRoleKey: createServiceRoleToken(gotrueJwtSecret, { now }),
    mailpitOrigin,
    migrationDatabaseUrl: databaseUrl(
      roles.migrator,
      migratorPassword,
      "127.0.0.1",
      ports.postgres,
      identity.databaseName,
    ),
    migratorPassword,
    postgresPassword,
    processMarkers: identity.processMarkers,
    runtimeDatabaseUrl: databaseUrl(
      roles.runtime,
      runtimePassword,
      "127.0.0.1",
      ports.postgres,
      identity.databaseName,
    ),
    runtimePassword,
    sessionSecret,
    ports,
  });
}

export function buildChildEnvironments(configuration, inheritedEnvironment) {
  const system = systemEnvironment(inheritedEnvironment);
  const docker = dockerSystemEnvironment(inheritedEnvironment);
  return Object.freeze({
    docker: childEnvironment(docker, {}),
    process: childEnvironment(system, {}),
    compose: childEnvironment(docker, {
      GOTRUE_JWT_SECRET: configuration.gotrueJwtSecret,
      SMOKE_APP_ORIGIN: configuration.appOrigin,
      SMOKE_DATABASE_NAME: configuration.databaseName,
      SMOKE_GOTRUE_DATABASE_URL: configuration.gotrueDatabaseUrl,
      SMOKE_GOTRUE_ORIGIN: configuration.gotrueOrigin,
      SMOKE_GOTRUE_PORT: String(configuration.ports.gotrue),
      SMOKE_MAILPIT_PORT: String(configuration.ports.mailpit),
      SMOKE_POSTGRES_PASSWORD: configuration.postgresPassword,
      SMOKE_POSTGRES_PORT: String(configuration.ports.postgres),
      SMOKE_SMTP_PORT: String(configuration.ports.smtp),
    }),
    migration: childEnvironment(system, {
      MIGRATION_DATABASE_URL: configuration.migrationDatabaseUrl,
    }),
    bootstrap: childEnvironment(system, {
      APP_ENV: "development",
      APP_ORIGIN: configuration.appOrigin,
      BOOTSTRAP_EMAIL: configuration.bootstrapEmail,
      DATABASE_URL: configuration.runtimeDatabaseUrl,
      GOTRUE_ORIGIN: configuration.gotrueOrigin,
      GOTRUE_SERVICE_ROLE_KEY: configuration.gotrueServiceRoleKey,
      SESSION_SECRET: configuration.sessionSecret,
    }),
    api: childEnvironment(system, {
      APP_ENV: "development",
      APP_ORIGIN: configuration.appOrigin,
      DATABASE_URL: configuration.runtimeDatabaseUrl,
      GOTRUE_ORIGIN: configuration.gotrueOrigin,
      GOTRUE_SERVICE_ROLE_KEY: configuration.gotrueServiceRoleKey,
      HOST: "127.0.0.1",
      PORT: String(configuration.ports.api),
      SESSION_SECRET: configuration.sessionSecret,
      SMTP_FROM: "auth@agency-workload.local",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(configuration.ports.smtp),
      SMTP_SENDER_NAME: "Agency Workload",
    }),
    webBuild: childEnvironment(system, { NODE_ENV: "production" }),
    web: childEnvironment(system, {
      SMOKE_API_ORIGIN: configuration.apiOrigin,
      SMOKE_WEB_MODE: "preview",
      SMOKE_WEB_PORT: String(configuration.ports.web),
    }),
    browser: childEnvironment(system, {
      APP_ORIGIN: configuration.appOrigin,
      BOOTSTRAP_EMAIL: configuration.bootstrapEmail,
      MAILPIT_ORIGIN: configuration.mailpitOrigin,
      SMOKE_BROWSER_PROFILE: configuration.browserProfileDirectory,
      SMOKE_PROCESS_MARKER: configuration.processMarkers.browser,
    }),
  });
}

export function buildAuthIntegrationEnvironment(
  configuration,
  inheritedEnvironment,
  { runToken } = {},
) {
  const suffix = configuration.processMarkers.auth.match(
    /^agency-workload-smoke-([a-f0-9]{32})-auth$/,
  )?.[1];
  if (!suffix) throw new Error("Auth integration process marker is invalid");
  runToken ??= `${suffix}${nodeRandomBytes(16).toString("hex")}`;
  if (!/^[a-f0-9]{64}$/.test(runToken) || runToken.slice(0, 32) !== suffix) {
    throw new Error("Auth integration run token is invalid");
  }
  const system = systemEnvironment(inheritedEnvironment);
  const values = {
    APP_ENV: "development",
    APP_ORIGIN: configuration.appOrigin,
    AW_AUTH_INTEGRATION: "1",
    AW_DISPOSABLE_COMPOSE_PROJECT: `agency-workload-smoke-${suffix}`,
    AW_DISPOSABLE_TEST_MARKER: configuration.processMarkers.auth,
    AW_DISPOSABLE_RUN_TOKEN: runToken,
    AW_EXPECTED_APP_ENV: "development",
    AW_EXPECTED_APP_ORIGIN: configuration.appOrigin,
    AW_EXPECTED_APP_PORT: String(configuration.ports.web),
    AW_EXPECTED_BOOTSTRAP_EMAIL: configuration.bootstrapEmail,
    AW_EXPECTED_COMPOSE_PROJECT: `agency-workload-smoke-${suffix}`,
    AW_EXPECTED_DATABASE_HOST: "127.0.0.1",
    AW_EXPECTED_DATABASE_NAME: configuration.databaseName,
    AW_EXPECTED_DATABASE_PORT: String(configuration.ports.postgres),
    AW_EXPECTED_DATABASE_URL: configuration.runtimeDatabaseUrl,
    AW_EXPECTED_DATABASE_USER: "agency_workload_runtime",
    AW_EXPECTED_GOTRUE_DATABASE_URL: configuration.gotrueHostDatabaseUrl,
    AW_EXPECTED_GOTRUE_ORIGIN: configuration.gotrueOrigin,
    AW_EXPECTED_GOTRUE_PORT: String(configuration.ports.gotrue),
    AW_EXPECTED_GOTRUE_SERVICE_ROLE_KEY: configuration.gotrueServiceRoleKey,
    AW_EXPECTED_MAILPIT_ORIGIN: configuration.mailpitOrigin,
    AW_EXPECTED_MAILPIT_PORT: String(configuration.ports.mailpit),
    AW_EXPECTED_SMTP_HOST: "127.0.0.1",
    AW_EXPECTED_SMTP_FROM: "auth@agency-workload.local",
    AW_EXPECTED_SMTP_PORT: String(configuration.ports.smtp),
    AW_EXPECTED_SMTP_SENDER_NAME: "Agency Workload",
    AW_EXPECTED_SESSION_SECRET: configuration.sessionSecret,
    BOOTSTRAP_EMAIL: configuration.bootstrapEmail,
    DATABASE_URL: configuration.runtimeDatabaseUrl,
    GOTRUE_DATABASE_URL: configuration.gotrueHostDatabaseUrl,
    GOTRUE_ORIGIN: configuration.gotrueOrigin,
    GOTRUE_SERVICE_ROLE_KEY: configuration.gotrueServiceRoleKey,
    MAILPIT_ORIGIN: configuration.mailpitOrigin,
    SESSION_SECRET: configuration.sessionSecret,
    SMTP_FROM: "auth@agency-workload.local",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(configuration.ports.smtp),
    SMTP_SENDER_NAME: "Agency Workload",
  };
  values.AW_DISPOSABLE_TARGET_PROOF = createAuthTargetProof(
    runToken,
    canonicalAuthTargetManifest(values),
  );
  return childEnvironment(system, values);
}

export function buildInitializeClusterSql(configuration, identity) {
  assertSmokeIdentity(identity);
  return `
\\set ON_ERROR_STOP on
CREATE ROLE ${roles.owner} WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE postgres WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
CREATE ROLE ${roles.migrator} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 5 PASSWORD ${sqlLiteral(configuration.migratorPassword)};
CREATE ROLE ${roles.runtime} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 20 PASSWORD ${sqlLiteral(configuration.runtimePassword)};
CREATE ROLE ${roles.auth} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 20 PASSWORD ${sqlLiteral(configuration.authPassword)};
CREATE ROLE ${roles.backup} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION INHERIT CONNECTION LIMIT 2 PASSWORD ${sqlLiteral(configuration.backupPassword)};
CREATE DATABASE "${identity.databaseName}" WITH OWNER ${roles.owner} ENCODING 'UTF8' TEMPLATE template0;
REVOKE ALL ON DATABASE "${identity.databaseName}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${identity.databaseName}" TO ${roles.migrator}, ${roles.runtime}, ${roles.auth}, ${roles.backup};
ALTER ROLE ${roles.migrator} IN DATABASE "${identity.databaseName}" SET search_path = app, pg_catalog;
ALTER ROLE ${roles.runtime} IN DATABASE "${identity.databaseName}" SET search_path = app, pg_catalog;
ALTER ROLE ${roles.auth} IN DATABASE "${identity.databaseName}" SET search_path = auth, pg_catalog;
ALTER ROLE ${roles.backup} IN DATABASE "${identity.databaseName}" SET search_path = app, auth, pg_catalog;
`;
}

export function buildInitializeDatabaseSql() {
  return `
\\set ON_ERROR_STOP on
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM ${roles.migrator}, ${roles.runtime}, ${roles.auth}, ${roles.backup};
CREATE SCHEMA app AUTHORIZATION ${roles.owner};
CREATE SCHEMA auth AUTHORIZATION ${roles.auth};
REVOKE ALL ON SCHEMA app FROM PUBLIC;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA app TO ${roles.migrator};
GRANT USAGE ON SCHEMA app TO ${roles.runtime}, ${roles.backup};
GRANT USAGE, CREATE ON SCHEMA auth TO ${roles.auth};
GRANT USAGE ON SCHEMA auth TO ${roles.backup};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA app
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roles.runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.owner} IN SCHEMA app
  GRANT SELECT ON TABLES TO ${roles.backup};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migrator} IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${roles.runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migrator} IN SCHEMA app
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${roles.runtime};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.migrator} IN SCHEMA app
  GRANT SELECT ON TABLES TO ${roles.backup};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.auth} IN SCHEMA auth
  GRANT SELECT ON TABLES TO ${roles.backup};
ALTER DEFAULT PRIVILEGES FOR ROLE ${roles.auth} IN SCHEMA auth
  GRANT SELECT ON SEQUENCES TO ${roles.backup};
`;
}

export function disposablePsqlInvocation(identity, target, composeFile = "COMPOSE_FILE") {
  assertSmokeIdentity(identity);
  const database =
    target === "postgres" ? "postgres" : target === "application" ? identity.databaseName : null;
  if (!database) throw new Error("Browser smoke psql target is not allowlisted");
  return {
    command: "docker",
    args: [
      "compose",
      "--project-name",
      identity.composeProject,
      "-f",
      composeFile,
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "smoke_admin",
      "--dbname",
      database,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
  };
}
