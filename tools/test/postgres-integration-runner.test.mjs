import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createSmokeConfiguration, createSmokeIdentity } from "../lib/disposable-browser-smoke.mjs";
import {
  assertPostgresDockerOverridesSafe,
  createPostgresIntegrationIdentity,
  postgresComposeInvocation,
  POSTGRES_INTEGRATION_CLEANUP_BUDGET_MS,
  POSTGRES_INTEGRATION_MAIN_BUDGET_MS,
} from "../lib/disposable-postgres-integration.mjs";
import {
  assertExactPostgresIntegrationBoundary,
  buildPostgresIntegrationEnvironment,
  canonicalPostgresTargetManifest,
  createPostgresTargetProof,
  disposableIntegrationPsqlInvocation,
  POSTGRES_INTEGRATION_SUITES,
  runDisposablePostgresSql,
} from "../lib/postgres-integration-boundary.mjs";
import {
  CANONICAL_SYNC_ONLY_MESSAGE,
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
  runPublicMirrorCommand,
} from "../public-mirror-command.mjs";

const suffix = "1234567890abcdef1234567890abcdef";
const runToken = `${suffix}${"d".repeat(32)}`;
const identity = createSmokeIdentity(suffix);
const suiteContracts = Object.freeze({
  db: Object.freeze({
    bootstrapOwner: false,
    databaseEnvironment: "MIGRATION_DATABASE_URL",
    databaseUser: "agency_workload_migrator",
    flag: "AW_DB_INTEGRATION",
    migrate: false,
    testFile: "packages/db/test/integration.test.ts",
    vitestArgs: ["--testTimeout=30000", "--hookTimeout=30000"],
  }),
  admin: Object.freeze({
    bootstrapOwner: true,
    databaseEnvironment: "DATABASE_URL",
    databaseUser: "agency_workload_runtime",
    flag: "AW_ADMIN_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/admin.integration.test.ts",
    vitestArgs: [],
  }),
  planning: Object.freeze({
    bootstrapOwner: true,
    databaseEnvironment: "DATABASE_URL",
    databaseUser: "agency_workload_runtime",
    flag: "AW_PLANNING_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/planning.integration.test.ts",
    vitestArgs: [],
  }),
  extended: Object.freeze({
    bootstrapOwner: false,
    databaseEnvironment: "DATABASE_URL",
    databaseUser: "agency_workload_runtime",
    flag: "AW_EXTENDED_INTEGRATION",
    migrate: true,
    testFile: "apps/api/test/extended.integration.test.ts",
    vitestArgs: ["--testTimeout=30000"],
  }),
});
const suiteNames = Object.keys(suiteContracts);
const adminConfigurationKeys = [
  "APP_ENV",
  "APP_ORIGIN",
  "GOTRUE_ORIGIN",
  "GOTRUE_SERVICE_ROLE_KEY",
  "SESSION_SECRET",
  "SMTP_FROM",
  "SMTP_HOST",
  "SMTP_PORT",
  "SMTP_SENDER_NAME",
];
const ports = {
  postgres: 53_100,
  web: 53_101,
  api: 53_102,
  gotrue: 53_103,
  smtp: 53_104,
  mailpit: 53_105,
};
const baseEnvironment = {
  AW_POSTGRES_HOST_PORT: "5434",
  APP_ORIGIN: "http://localhost:3100",
  API_ORIGIN: "http://localhost:4100",
  GOTRUE_ORIGIN: "http://127.0.0.1:9999",
  MAILPIT_ORIGIN: "http://127.0.0.1:8025",
  PATH: process.env.PATH,
  SMTP_PORT: "1025",
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
};
const configuration = createSmokeConfiguration(identity, ports, {
  now: 1_800_000_000,
  randomBytes: (size) => Buffer.alloc(size, 17),
});

function suiteEnvironment(suite, inheritedEnvironment = baseEnvironment) {
  return buildPostgresIntegrationEnvironment({
    configuration,
    identity,
    inheritedEnvironment,
    runToken,
    suite,
  });
}

function resign(environment) {
  const signed = { ...environment };
  signed.AW_DISPOSABLE_TARGET_PROOF = createPostgresTargetProof(
    signed.AW_DISPOSABLE_RUN_TOKEN,
    canonicalPostgresTargetManifest(signed),
  );
  return signed;
}

test("the generic PostgreSQL harness exposes only the four exact DB-backed suites", () => {
  assert.deepEqual(Object.keys(POSTGRES_INTEGRATION_SUITES), suiteNames);
  for (const suite of suiteNames) {
    const definition = POSTGRES_INTEGRATION_SUITES[suite];
    const expected = suiteContracts[suite];
    assert.deepEqual(
      {
        bootstrapOwner: definition.bootstrapOwner,
        databaseEnvironment: definition.databaseEnvironment,
        databaseUser: definition.databaseUser,
        flag: definition.flag,
        migrate: definition.migrate,
        testFile: definition.testFile,
        vitestArgs: definition.vitestArgs,
      },
      expected,
    );
    const derived = createPostgresIntegrationIdentity(runToken, suite);
    assert.equal(derived.composeProject, identity.composeProject);
    assert.equal(derived.databaseName, identity.databaseName);
    assert.equal(derived.marker, `${identity.composeProject}-${suite}`);
  }
  assert.throws(() => createPostgresIntegrationIdentity("invalid", "planning"), /token/i);
  assert.throws(() => createPostgresIntegrationIdentity(runToken, "auth"), /suite/i);
});

test("PostgreSQL harness refuses every Docker endpoint selector before CLI use", () => {
  assert.doesNotThrow(() => assertPostgresDockerOverridesSafe({}));
  for (const environment of [
    { DOCKER_CONFIG: "alternate-config" },
    { DOCKER_CONTEXT: "remote-context" },
    { DOCKER_HOST: "tcp://remote.invalid:2376" },
  ]) {
    assert.throws(() => assertPostgresDockerOverridesSafe(environment), /refuses/i);
  }
});

test("every suite receives one exact flag and a least-privilege signed PostgreSQL environment", () => {
  const inherited = {
    ...baseEnvironment,
    BACKUP_DATABASE_URL: "persistent-backup",
    COMPOSE_FILE: "unsafe-compose-file",
    DATABASE_URL: "persistent-runtime",
    DOCKER_CONFIG: "unsafe-docker-config",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_HOST: "tcp://remote.invalid:2376",
    GOTRUE_SERVICE_ROLE_KEY: "persistent-service-role",
    MIGRATION_DATABASE_URL: "persistent-migrator",
    PGHOST: "remote.invalid",
    PGPASSWORD: "persistent-password",
    SESSION_SECRET: "persistent-session",
    SMOKE_POSTGRES_PASSWORD: "persistent-postgres",
  };
  for (const [suite, contract] of Object.entries(suiteContracts)) {
    const environment = suiteEnvironment(suite, inherited);
    const expectedUrl =
      contract.databaseEnvironment === "DATABASE_URL"
        ? configuration.runtimeDatabaseUrl
        : configuration.migrationDatabaseUrl;
    assert.equal(environment[contract.flag], "1");
    assert.equal(environment.AW_DISPOSABLE_COMPOSE_PROJECT, identity.composeProject);
    assert.equal(environment.AW_DISPOSABLE_COMPOSE_FILE, "infra/compose.smoke.yml");
    assert.equal(environment.AW_DISPOSABLE_TEST_MARKER, `${identity.composeProject}-${suite}`);
    assert.equal(environment[contract.databaseEnvironment], expectedUrl);
    assert.equal(new URL(expectedUrl).port, String(ports.postgres));
    assert.equal(new URL(expectedUrl).pathname, `/${identity.databaseName}`);
    assert.doesNotThrow(() => assertExactPostgresIntegrationBoundary(environment, suite));

    for (const definition of Object.values(suiteContracts)) {
      if (definition.flag !== contract.flag) assert.equal(environment[definition.flag], undefined);
    }
    for (const key of [
      "API_ORIGIN",
      "AW_AUTH_INTEGRATION",
      "BACKUP_DATABASE_URL",
      "COMPOSE_FILE",
      "DOCKER_CONFIG",
      "DOCKER_CONTEXT",
      "DOCKER_HOST",
      "MAILPIT_ORIGIN",
      "PGHOST",
      "PGPASSWORD",
      "SMOKE_POSTGRES_PASSWORD",
    ]) {
      assert.equal(environment[key], undefined, `${key} leaked into the ${suite} child`);
    }
    for (const key of adminConfigurationKeys) {
      if (suite === "admin") assert.equal(typeof environment[key], "string");
      else assert.equal(environment[key], undefined, `${key} leaked into the ${suite} child`);
    }
    if (suite === "admin") {
      assert.equal(environment.APP_ENV, "test");
      assert.equal(environment.APP_ORIGIN, "http://localhost:1");
      assert.equal(environment.GOTRUE_ORIGIN, "http://127.0.0.1:2");
      assert.equal(environment.SMTP_HOST, "127.0.0.1");
      assert.equal(environment.SMTP_PORT, "3");
      assert.notEqual(environment.GOTRUE_SERVICE_ROLE_KEY, inherited.GOTRUE_SERVICE_ROLE_KEY);
      assert.notEqual(environment.SESSION_SECRET, inherited.SESSION_SECRET);
    }
    const alternate =
      contract.databaseEnvironment === "DATABASE_URL" ? "MIGRATION_DATABASE_URL" : "DATABASE_URL";
    assert.equal(environment[alternate], undefined);
  }
});

test("boundary rejects persistent names, ports, URL options, alternate targets, and libpq overrides", () => {
  const valid = suiteEnvironment("planning");
  const cases = [
    resign({
      ...valid,
      DATABASE_URL: valid.DATABASE_URL.replace(`:${ports.postgres}/`, ":5434/"),
      AW_EXPECTED_DATABASE_PORT: "5434",
      AW_EXPECTED_DATABASE_URL: valid.AW_EXPECTED_DATABASE_URL.replace(
        `:${ports.postgres}/`,
        ":5434/",
      ),
    }),
    resign({
      ...valid,
      DATABASE_URL: valid.DATABASE_URL.replace(identity.databaseName, "agency_workload"),
      AW_EXPECTED_DATABASE_NAME: "agency_workload",
      AW_EXPECTED_DATABASE_URL: valid.AW_EXPECTED_DATABASE_URL.replace(
        identity.databaseName,
        "agency_workload",
      ),
    }),
    resign({
      ...valid,
      AW_DISPOSABLE_COMPOSE_PROJECT: "agency-workload",
      AW_EXPECTED_COMPOSE_PROJECT: "agency-workload",
    }),
    resign({
      ...valid,
      AW_DISPOSABLE_COMPOSE_FILE: "infra/compose.dev.yml",
      AW_EXPECTED_COMPOSE_FILE: "infra/compose.dev.yml",
    }),
    resign({
      ...valid,
      DATABASE_URL: `${valid.DATABASE_URL}?host=remote.invalid`,
      AW_EXPECTED_DATABASE_URL: `${valid.AW_EXPECTED_DATABASE_URL}?host=remote.invalid`,
    }),
    resign({ ...valid, MIGRATION_DATABASE_URL: configuration.migrationDatabaseUrl }),
    resign({ ...valid, PGHOST: "remote.invalid" }),
    resign({ ...valid, PGPASSWORD: "override" }),
  ];
  for (const environment of cases) {
    assert.throws(
      () => assertExactPostgresIntegrationBoundary(environment, "planning"),
      /Disposable PostgreSQL integration/,
    );
  }
});

test("admin boundary rejects persistent application defaults even with a recomputed proof", () => {
  const valid = suiteEnvironment("admin");
  for (const environment of [
    resign({ ...valid, APP_ORIGIN: "http://localhost:3100" }),
    resign({ ...valid, GOTRUE_ORIGIN: "http://127.0.0.1:9999" }),
    resign({ ...valid, SMTP_PORT: "1025" }),
    resign({ ...valid, SESSION_SECRET: "persistent-session" }),
  ]) {
    assert.throws(
      () => assertExactPostgresIntegrationBoundary(environment, "admin"),
      /Disposable PostgreSQL integration/,
    );
  }
});

test("every suite refuses missing, wrong-proof, and re-signed cross-suite markers before execution", () => {
  for (const [index, suite] of suiteNames.entries()) {
    const valid = suiteEnvironment(suite);
    const wrongSuite = suiteNames[(index + 1) % suiteNames.length];
    const cases = [
      { ...valid, AW_DISPOSABLE_TEST_MARKER: undefined },
      { ...valid, AW_DISPOSABLE_TARGET_PROOF: "0".repeat(64) },
      resign({ ...valid, AW_DISPOSABLE_TEST_MARKER: `${identity.composeProject}-${wrongSuite}` }),
    ];
    for (const environment of cases) {
      let executed = false;
      assert.throws(
        () =>
          runDisposablePostgresSql(environment, suite, "SELECT 1;", () => {
            executed = true;
          }),
        /Disposable PostgreSQL integration/,
      );
      assert.equal(executed, false);
    }
  }
});

test("every suite uses exact validated Compose PostgreSQL psql over stdin", () => {
  const expected = {
    command: "docker",
    args: [
      "compose",
      "--project-name",
      identity.composeProject,
      "-f",
      "infra/compose.smoke.yml",
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "smoke_admin",
      "--dbname",
      identity.databaseName,
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
  };
  for (const suite of suiteNames) {
    const environment = suiteEnvironment(suite);
    assert.deepEqual(disposableIntegrationPsqlInvocation(environment, suite), expected);

    let observed;
    runDisposablePostgresSql(environment, suite, "SELECT 1;", (command, args, options) => {
      observed = { args, command, options };
      return "";
    });
    assert.equal(observed.options.input, "SELECT 1;");
    assert.equal(observed.options.env.COMPOSE_DISABLE_ENV_FILE, "true");
    assert.equal(observed.options.env.DATABASE_URL, undefined);
    assert.equal(observed.options.env.MIGRATION_DATABASE_URL, undefined);
    assert.equal(observed.options.env.PGHOST, undefined);
    assert.equal(observed.args.includes(configuration.postgresPassword), false);
    assert.doesNotMatch(observed.args.join(" "), /project-postgres|agency_workload(?:\s|$)/i);
  }
});

test("every suite's startup and cleanup commands stay scoped to its generated project", () => {
  for (const suite of suiteNames) {
    const suiteIdentity = createPostgresIntegrationIdentity(runToken, suite);
    assert.deepEqual(
      postgresComposeInvocation(
        suiteIdentity,
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "120",
        "postgres",
      ),
      {
        command: "docker",
        args: [
          "compose",
          "--project-name",
          identity.composeProject,
          "-f",
          "infra/compose.smoke.yml",
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "120",
          "postgres",
        ],
      },
    );
    assert.deepEqual(postgresComposeInvocation(suiteIdentity, "down", "-v", "--remove-orphans"), {
      command: "docker",
      args: [
        "compose",
        "--project-name",
        identity.composeProject,
        "-f",
        "infra/compose.smoke.yml",
        "down",
        "-v",
        "--remove-orphans",
      ],
    });
  }
});

test("all four exact runners delegate only their registered file to the disposable harness", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  for (const [suite, contract] of Object.entries(suiteContracts)) {
    const runner = await readFile(
      new URL(`../run-${suite}-integration.mjs`, import.meta.url),
      "utf8",
    );
    assert.match(runner, /runDisposablePostgresIntegration/);
    assert.match(runner, new RegExp(contract.testFile.replaceAll("/", "[\\\\/]")));
    assert.doesNotMatch(runner, /spawnSync|project-postgres|compose\.dev|127\.0\.0\.1:5434/);
    assert.equal(
      manifest.scripts[`test:${suite}:integration`],
      `node tools/run-${suite}-integration.mjs`,
    );
  }
});

test("public tooling and PostgreSQL allowlist match the exact repository origin", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const origin = readExactOrigin(root);

  if (origin === PRIVATE_CANONICAL_ORIGIN) {
    const allowlist = JSON.parse(
      await readFile(new URL("../public-files.json", import.meta.url), "utf8"),
    ).include;
    for (const path of [
      "apps",
      "docs",
      "infra",
      "packages",
      "tools/lib",
      "tools/public-mirror-command.mjs",
      "tools/run-admin-integration.mjs",
      "tools/run-db-integration.mjs",
      "tools/run-extended-integration.mjs",
      "tools/run-planning-integration.mjs",
      "tools/run-postgres-integration-child.mjs",
      "tools/test",
    ]) {
      assert.ok(allowlist.includes(path), `public allowlist is missing ${path}`);
    }
    assert.equal(
      allowlist.some((path) => path.startsWith("tools/lib/")),
      false,
    );
    for (const privateOnlyPath of [
      "tools/public-files.json",
      "tools/sync-public.mjs",
      "tools/verify-public.mjs",
    ]) {
      assert.equal(allowlist.includes(privateOnlyPath), false);
    }
    return;
  }

  if (origin === PUBLIC_MIRROR_ORIGIN) {
    for (const path of ["public-files.json", "sync-public.mjs", "verify-public.mjs"]) {
      await assert.rejects(readFile(new URL(`../${path}`, import.meta.url), "utf8"), (error) => {
        assert.equal(error.code, "ENOENT");
        return true;
      });
    }
    await assert.rejects(runPublicMirrorCommand("sync", { origin, root }), (error) => {
      assert.equal(error.message, CANONICAL_SYNC_ONLY_MESSAGE);
      return true;
    });
    const verification = await runPublicMirrorCommand("verify", {
      logger: { log() {} },
      origin,
      root,
    });
    assert.ok(verification.fileCount > 0);
    return;
  }

  assert.fail(`Tool tests do not support repository origin: ${origin}`);
});

test("every enabled suite validates before DB/Docker use and refuses invalid manifests", async () => {
  for (const [index, [suite, contract]] of Object.entries(suiteContracts).entries()) {
    const source = await readFile(new URL(`../../${contract.testFile}`, import.meta.url), "utf8");
    const assertion = source.indexOf("assertExactPostgresIntegrationBoundary");
    assert.ok(assertion >= 0, `${suite} boundary assertion is missing`);
    for (const operation of ["new Pool", "loadConfig(", "runDisposablePostgresSql("]) {
      const operationIndex = source.indexOf(operation);
      if (operationIndex >= 0) {
        assert.ok(assertion < operationIndex, `${suite} validates after ${operation}`);
      }
    }
    assert.doesNotMatch(
      source,
      /project-postgres|session_replication_role|docker["']\s*,\s*\[\s*["']exec/i,
    );

    const valid = suiteEnvironment(suite);
    const wrongSuite = suiteNames[(index + 1) % suiteNames.length];
    for (const environment of [
      { ...valid, AW_DISPOSABLE_TEST_MARKER: undefined },
      { ...valid, AW_DISPOSABLE_TARGET_PROOF: "0".repeat(64) },
      resign({ ...valid, AW_DISPOSABLE_TEST_MARKER: `${identity.composeProject}-${wrongSuite}` }),
    ]) {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", `import('./${contract.testFile}')`],
        {
          cwd: new URL("../../", import.meta.url),
          encoding: "utf8",
          env: environment,
          timeout: 10_000,
          windowsHide: true,
        },
      );
      assert.notEqual(result.status, 0, `${suite} accepted an invalid manifest`);
      assert.match(result.stderr, /Disposable PostgreSQL integration/);
      assert.doesNotMatch(result.stderr, /postgresql:\/\/|password|Bearer |eyJ/);
    }
  }
});

test("PostgreSQL child refuses arbitrary suites, files, and flags before Vitest", () => {
  const cases = [
    {
      arguments: ["auth", "apps/api/test/auth.integration.test.ts", "--smoke-process-marker=bad"],
      environment: baseEnvironment,
    },
    {
      arguments: [
        "db",
        "apps/api/test/admin.integration.test.ts",
        `--smoke-process-marker=${identity.composeProject}-db`,
      ],
      environment: suiteEnvironment("db"),
    },
    {
      arguments: [
        "admin",
        "apps/api/test/admin.integration.test.ts",
        "--runInBand",
        `--smoke-process-marker=${identity.composeProject}-admin`,
      ],
      environment: suiteEnvironment("admin"),
    },
  ];
  for (const testCase of cases) {
    const result = spawnSync(
      process.execPath,
      ["tools/run-postgres-integration-child.mjs", ...testCase.arguments],
      {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        env: testCase.environment,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /child target is invalid/);
  }
});

test("PostgreSQL harness owns one deadline, separate cleanup, signals, trees, and residual scans", async () => {
  const [harness, child] = await Promise.all([
    readFile(new URL("../lib/disposable-postgres-integration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../run-postgres-integration-child.mjs", import.meta.url), "utf8"),
  ]);
  assert.equal(POSTGRES_INTEGRATION_MAIN_BUDGET_MS, 240_000);
  assert.equal(POSTGRES_INTEGRATION_CLEANUP_BUDGET_MS, 30_000);
  assert.match(harness, /createOperationDeadline/);
  assert.match(harness, /createShutdownCoordinator/);
  assert.match(harness, /stopManagedProcessTree/);
  assert.match(harness, /assertResourcesAbsent/);
  assert.match(harness, /assertPortClosed/);
  assert.match(harness, /COMPOSE_DISABLE_ENV_FILE/);
  assert.match(harness, /"up", "-d", "--wait", "--wait-timeout", "120", "postgres"/);
  assert.doesNotMatch(harness, /composeWith\([^)]*"(?:gotrue|mailpit)"/);
  assert.doesNotMatch(child, /timeout\s*:|taskkill|SIGKILL|\.kill\(/);
});
