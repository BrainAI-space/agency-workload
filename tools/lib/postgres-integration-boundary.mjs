import { execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tokenPattern = /^[a-f0-9]{64}$/;
const suffixPattern = /^[a-f0-9]{32}$/;
const composePattern = /^agency-workload-smoke-([a-f0-9]{32})$/;
const databasePattern = /^agency_workload_smoke_([a-f0-9]{32})$/;
const markerPattern = /^agency-workload-smoke-([a-f0-9]{32})-(db|admin|planning|extended)$/;
const disposablePortMin = 49_152;
const disposablePortMax = 60_999;
const composeFile = "infra/compose.smoke.yml";
const root = dirname(fileURLToPath(new URL("../../package.json", import.meta.url)));
const systemEnvironmentKeys = Object.freeze([
  "APPDATA",
  "ComSpec",
  "HOME",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "Path",
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
const postgresIntegrationFlags = Object.freeze([
  "AW_AUTH_INTEGRATION",
  "AW_DB_INTEGRATION",
  "AW_ADMIN_INTEGRATION",
  "AW_PLANNING_INTEGRATION",
  "AW_EXTENDED_INTEGRATION",
]);
const manifestKeys = Object.freeze([
  "AW_DISPOSABLE_COMPOSE_FILE",
  "AW_DISPOSABLE_COMPOSE_PROJECT",
  "AW_DISPOSABLE_INTEGRATION_SUITE",
  "AW_DISPOSABLE_TEST_MARKER",
  "AW_EXPECTED_COMPOSE_FILE",
  "AW_EXPECTED_COMPOSE_PROJECT",
  "AW_EXPECTED_DATABASE_ENVIRONMENT",
  "AW_EXPECTED_DATABASE_HOST",
  "AW_EXPECTED_DATABASE_NAME",
  "AW_EXPECTED_DATABASE_PORT",
  "AW_EXPECTED_DATABASE_URL",
  "AW_EXPECTED_DATABASE_USER",
  "AW_EXPECTED_INTEGRATION_FLAG",
]);
const adminConfigurationKeys = Object.freeze([
  "APP_ENV",
  "APP_ORIGIN",
  "GOTRUE_ORIGIN",
  "GOTRUE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
  "SMTP_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SENDER_NAME",
]);

export const POSTGRES_INTEGRATION_SUITES = Object.freeze({
  db: Object.freeze({
    bootstrapOwner: false,
    databaseEnvironment: "MIGRATION_DATABASE_URL",
    databaseUrl: (configuration) => configuration.migrationDatabaseUrl,
    databaseUser: "agency_workload_migrator",
    flag: "AW_DB_INTEGRATION",
    migrate: false,
    testFile: "packages/db/test/integration.test.ts",
    vitestArgs: Object.freeze(["--testTimeout=30000", "--hookTimeout=30000"]),
  }),
  admin: Object.freeze({
    bootstrapOwner: true,
    databaseEnvironment: "DATABASE_URL",
    databaseUrl: (configuration) => configuration.runtimeDatabaseUrl,
    databaseUser: "agency_workload_runtime",
    flag: "AW_ADMIN_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/admin.integration.test.ts",
    vitestArgs: Object.freeze([]),
  }),
  planning: Object.freeze({
    bootstrapOwner: true,
    databaseEnvironment: "DATABASE_URL",
    databaseUrl: (configuration) => configuration.runtimeDatabaseUrl,
    databaseUser: "agency_workload_runtime",
    flag: "AW_PLANNING_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/planning.integration.test.ts",
    vitestArgs: Object.freeze([]),
  }),
  extended: Object.freeze({
    bootstrapOwner: false,
    databaseEnvironment: "DATABASE_URL",
    databaseUrl: (configuration) => configuration.runtimeDatabaseUrl,
    databaseUser: "agency_workload_runtime",
    flag: "AW_EXTENDED_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/extended.integration.test.ts",
    vitestArgs: Object.freeze(["--testTimeout=30000"]),
  }),
});

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Disposable PostgreSQL integration expected target is missing: ${key}`);
  }
  return value;
}

function suiteDefinition(suite) {
  const definition = POSTGRES_INTEGRATION_SUITES[suite];
  if (!definition) throw new Error("Disposable PostgreSQL integration suite is invalid");
  return definition;
}

function systemEnvironment(environment) {
  const result = {};
  for (const key of systemEnvironmentKeys) {
    if (typeof environment[key] === "string" && environment[key]) result[key] = environment[key];
  }
  return result;
}

function exactUrl(value, expected) {
  let actualUrl;
  let expectedUrl;
  try {
    actualUrl = new URL(value);
    expectedUrl = new URL(expected);
  } catch {
    throw new Error("Disposable PostgreSQL integration database URL is invalid");
  }
  if (
    actualUrl.toString() !== expectedUrl.toString() ||
    actualUrl.search ||
    actualUrl.hash ||
    expectedUrl.search ||
    expectedUrl.hash
  ) {
    throw new Error("Disposable PostgreSQL integration database URL target mismatch");
  }
  return actualUrl;
}

function assertPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < disposablePortMin || port > disposablePortMax) {
    throw new Error("Disposable PostgreSQL integration database port is unsafe");
  }
  return port;
}

function derivedValue(runToken, label) {
  return createHmac("sha256", Buffer.from(runToken, "hex")).update(label).digest("base64url");
}

function adminConfiguration(runToken) {
  return Object.freeze({
    APP_ENV: "test",
    APP_ORIGIN: "http://localhost:1",
    GOTRUE_ORIGIN: "http://127.0.0.1:2",
    GOTRUE_SERVICE_ROLE_KEY: derivedValue(runToken, "admin-gotrue-service-role"),
    SESSION_SECRET: derivedValue(runToken, "admin-session"),
    SMTP_FROM: "auth@agency-workload.local",
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: "3",
    SMTP_SENDER_NAME: "Agency Workload",
  });
}

export function canonicalPostgresTargetManifest(environment) {
  const suite = required(environment, "AW_DISPOSABLE_INTEGRATION_SUITE");
  suiteDefinition(suite);
  const keys = suite === "admin" ? [...manifestKeys, ...adminConfigurationKeys] : manifestKeys;
  return keys.map((key) => `${key}=${required(environment, key)}`).join("\n");
}

export function createPostgresTargetProof(runToken, canonicalManifest) {
  if (!tokenPattern.test(runToken)) {
    throw new Error("Disposable PostgreSQL integration run token is invalid");
  }
  return createHmac("sha256", Buffer.from(runToken, "hex"))
    .update(canonicalManifest, "utf8")
    .digest("hex");
}

export function buildPostgresIntegrationEnvironment({
  configuration,
  identity,
  inheritedEnvironment,
  runToken,
  suite,
}) {
  const definition = suiteDefinition(suite);
  if (!tokenPattern.test(runToken) || runToken.slice(0, 32) !== identity?.suffix) {
    throw new Error("Disposable PostgreSQL integration run token is invalid");
  }
  if (!suffixPattern.test(identity.suffix)) {
    throw new Error("Disposable PostgreSQL integration identity is invalid");
  }
  const marker = `${identity.composeProject}-${suite}`;
  const databaseUrl = definition.databaseUrl(configuration);
  const values = {
    AW_DISPOSABLE_COMPOSE_FILE: composeFile,
    AW_DISPOSABLE_COMPOSE_PROJECT: identity.composeProject,
    AW_DISPOSABLE_INTEGRATION_SUITE: suite,
    AW_DISPOSABLE_RUN_TOKEN: runToken,
    AW_DISPOSABLE_TEST_MARKER: marker,
    AW_EXPECTED_COMPOSE_FILE: composeFile,
    AW_EXPECTED_COMPOSE_PROJECT: identity.composeProject,
    AW_EXPECTED_DATABASE_ENVIRONMENT: definition.databaseEnvironment,
    AW_EXPECTED_DATABASE_HOST: "127.0.0.1",
    AW_EXPECTED_DATABASE_NAME: identity.databaseName,
    AW_EXPECTED_DATABASE_PORT: String(configuration.ports.postgres),
    AW_EXPECTED_DATABASE_URL: databaseUrl,
    AW_EXPECTED_DATABASE_USER: definition.databaseUser,
    AW_EXPECTED_INTEGRATION_FLAG: definition.flag,
    [definition.databaseEnvironment]: databaseUrl,
    [definition.flag]: "1",
    ...(suite === "admin" ? adminConfiguration(runToken) : {}),
  };
  values.AW_DISPOSABLE_TARGET_PROOF = createPostgresTargetProof(
    runToken,
    canonicalPostgresTargetManifest(values),
  );
  return Object.freeze({ ...systemEnvironment(inheritedEnvironment), ...values });
}

export function assertExactPostgresIntegrationBoundary(environment, expectedSuite) {
  const definition = suiteDefinition(expectedSuite);
  const suite = required(environment, "AW_DISPOSABLE_INTEGRATION_SUITE");
  if (suite !== expectedSuite) {
    throw new Error("Disposable PostgreSQL integration suite target mismatch");
  }

  const token = required(environment, "AW_DISPOSABLE_RUN_TOKEN");
  if (!tokenPattern.test(token)) {
    throw new Error("Disposable PostgreSQL integration run token is invalid");
  }
  const actualProof = required(environment, "AW_DISPOSABLE_TARGET_PROOF");
  if (!tokenPattern.test(actualProof)) {
    throw new Error("Disposable PostgreSQL integration target proof is invalid");
  }
  const expectedProof = createPostgresTargetProof(
    token,
    canonicalPostgresTargetManifest(environment),
  );
  const expectedProofBytes = Buffer.from(expectedProof, "hex");
  const actualProofBytes = Buffer.from(actualProof, "hex");
  if (
    expectedProofBytes.length !== actualProofBytes.length ||
    !timingSafeEqual(expectedProofBytes, actualProofBytes)
  ) {
    throw new Error("Disposable PostgreSQL integration target proof mismatch");
  }

  const marker = required(environment, "AW_DISPOSABLE_TEST_MARKER");
  const markerMatch = marker.match(markerPattern);
  if (!markerMatch || markerMatch[1] !== token.slice(0, 32) || markerMatch[2] !== suite) {
    throw new Error("Disposable PostgreSQL integration marker is invalid");
  }
  const composeProject = required(environment, "AW_DISPOSABLE_COMPOSE_PROJECT");
  const composeMatch = composeProject.match(composePattern);
  if (
    !composeMatch ||
    composeMatch[1] !== markerMatch[1] ||
    composeProject !== required(environment, "AW_EXPECTED_COMPOSE_PROJECT")
  ) {
    throw new Error("Disposable PostgreSQL integration Compose project mismatch");
  }
  if (
    required(environment, "AW_DISPOSABLE_COMPOSE_FILE") !== composeFile ||
    required(environment, "AW_EXPECTED_COMPOSE_FILE") !== composeFile
  ) {
    throw new Error("Disposable PostgreSQL integration Compose file mismatch");
  }

  if (
    required(environment, "AW_EXPECTED_INTEGRATION_FLAG") !== definition.flag ||
    required(environment, "AW_EXPECTED_DATABASE_ENVIRONMENT") !== definition.databaseEnvironment
  ) {
    throw new Error("Disposable PostgreSQL integration suite contract mismatch");
  }
  for (const flag of postgresIntegrationFlags) {
    if (flag === definition.flag) {
      if (environment[flag] !== "1") {
        throw new Error("Disposable PostgreSQL integration flag is missing");
      }
    } else if (environment[flag] !== undefined) {
      throw new Error("Disposable PostgreSQL integration enabled an unexpected suite");
    }
  }
  if (
    Object.keys(environment).some(
      (key) =>
        /^PG[A-Z_]/.test(key) ||
        /^(?:DOCKER|COMPOSE)_/.test(key) ||
        (!key.startsWith("AW_") &&
          key !== definition.databaseEnvironment &&
          /DATABASE_URL$/.test(key)),
    )
  ) {
    throw new Error("Disposable PostgreSQL integration connection override is forbidden");
  }
  if (suite === "admin") {
    const expectedConfiguration = adminConfiguration(token);
    if (
      Object.entries(expectedConfiguration).some(
        ([key, value]) => required(environment, key) !== value,
      )
    ) {
      throw new Error("Disposable PostgreSQL integration admin configuration mismatch");
    }
  } else if (adminConfigurationKeys.some((key) => environment[key] !== undefined)) {
    throw new Error("Disposable PostgreSQL integration unexpected application configuration");
  }

  const expectedDatabasePort = assertPort(required(environment, "AW_EXPECTED_DATABASE_PORT"));
  const expectedDatabaseName = required(environment, "AW_EXPECTED_DATABASE_NAME");
  const databaseMatch = expectedDatabaseName.match(databasePattern);
  const expectedDatabaseHost = required(environment, "AW_EXPECTED_DATABASE_HOST");
  const expectedDatabaseUser = required(environment, "AW_EXPECTED_DATABASE_USER");
  const databaseUrl = exactUrl(
    required(environment, definition.databaseEnvironment),
    required(environment, "AW_EXPECTED_DATABASE_URL"),
  );
  if (
    !databaseMatch ||
    databaseMatch[1] !== markerMatch[1] ||
    expectedDatabaseHost !== "127.0.0.1" ||
    expectedDatabaseUser !== definition.databaseUser ||
    databaseUrl.protocol !== "postgresql:" ||
    databaseUrl.hostname !== expectedDatabaseHost ||
    databaseUrl.port !== String(expectedDatabasePort) ||
    databaseUrl.pathname !== `/${expectedDatabaseName}` ||
    decodeURIComponent(databaseUrl.username) !== expectedDatabaseUser ||
    !databaseUrl.password
  ) {
    throw new Error("Disposable PostgreSQL integration database target mismatch");
  }
}

export function disposableIntegrationPsqlInvocation(environment, expectedSuite) {
  assertExactPostgresIntegrationBoundary(environment, expectedSuite);
  return {
    command: "docker",
    args: [
      "compose",
      "--project-name",
      environment.AW_DISPOSABLE_COMPOSE_PROJECT,
      "-f",
      composeFile,
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "smoke_admin",
      "--dbname",
      environment.AW_EXPECTED_DATABASE_NAME,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
  };
}

function composeExecEnvironment(environment) {
  return {
    ...systemEnvironment(environment),
    COMPOSE_DISABLE_ENV_FILE: "true",
    GOTRUE_JWT_SECRET: "unused-by-postgres-integration",
    SMOKE_APP_ORIGIN: "http://localhost:1",
    SMOKE_DATABASE_NAME: environment.AW_EXPECTED_DATABASE_NAME,
    SMOKE_GOTRUE_DATABASE_URL: `postgresql://unused:unused@postgres:5432/${environment.AW_EXPECTED_DATABASE_NAME}`,
    SMOKE_GOTRUE_ORIGIN: "http://127.0.0.1:1",
    SMOKE_GOTRUE_PORT: "1",
    SMOKE_MAILPIT_PORT: "2",
    SMOKE_POSTGRES_PASSWORD: "unused-by-compose-exec",
    SMOKE_POSTGRES_PORT: environment.AW_EXPECTED_DATABASE_PORT,
    SMOKE_SMTP_PORT: "3",
  };
}

export function runDisposablePostgresSql(environment, expectedSuite, sql, execute = execFileSync) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new Error("Disposable PostgreSQL integration SQL is required");
  }
  const invocation = disposableIntegrationPsqlInvocation(environment, expectedSuite);
  try {
    execute(invocation.command, invocation.args, {
      cwd: root,
      encoding: "utf8",
      env: composeExecEnvironment(environment),
      input: sql,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    throw new Error("Disposable PostgreSQL integration SQL failed without exposing output");
  }
}
