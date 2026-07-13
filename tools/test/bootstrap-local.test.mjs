import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertExpectedTarget,
  buildDatabaseSql,
  buildMaintenanceSql,
  buildPasswordRotationSql,
  createLocalEnvironment,
  createRotatedEnvironment,
  credentialProbeInvocation,
  psqlInvocation,
  rotateLocalSecrets,
  rotationSummaryLines,
} from "../lib/bootstrap.mjs";
import {
  databaseUrlRules,
  directSecretKeys,
  expectedOrigins,
  expectedTarget,
  parseEnv,
  validateConfiguration,
} from "../lib/config.mjs";

function deterministicRandom() {
  let byte = 1;
  return (size) => Buffer.alloc(size, byte++);
}

test("createLocalEnvironment generates a complete valid development configuration", () => {
  const result = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  const values = parseEnv(result.text);

  assert.equal(result.changed, true);
  assert.deepEqual(validateConfiguration(values, { template: false }), []);
  assert.notEqual(new URL(values.get("DATABASE_URL")).password, "");
  assert.notEqual(
    new URL(values.get("DATABASE_URL")).password,
    new URL(values.get("MIGRATION_DATABASE_URL")).password,
  );
});

test("createLocalEnvironment preserves all existing secrets on repeated runs", () => {
  const first = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  const second = createLocalEnvironment(first.text, {
    now: 1_800_000_000,
    randomBytes() {
      throw new Error("random generation must not run for a complete environment");
    },
  });

  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("createLocalEnvironment migrates the legacy API origin without rotating secrets", () => {
  const initial = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  const legacyText = initial.text.replace(
    "API_ORIGIN=http://localhost:4100",
    "API_ORIGIN=http://localhost:3101",
  );
  const migrated = createLocalEnvironment(legacyText, {
    now: 1_800_000_000,
    randomBytes() {
      throw new Error("origin migration must not rotate secrets");
    },
  });
  const before = parseEnv(legacyText);
  const after = parseEnv(migrated.text);

  assert.equal(after.get("API_ORIGIN"), "http://localhost:4100");
  assert.equal(
    directSecretKeys.every((key) => before.get(key) === after.get(key)),
    true,
  );
  assert.equal(
    Object.keys(databaseUrlRules).every((key) => before.get(key) === after.get(key)),
    true,
  );
});

test("createRotatedEnvironment changes every secret and preserves every non-secret target", () => {
  const initial = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  const rotated = createRotatedEnvironment(initial.text, {
    now: 1_800_000_000,
    randomBytes: deterministicRandom(),
  });
  const before = parseEnv(initial.text);
  const after = parseEnv(rotated.text);

  const databasePasswordsChanged = Object.keys(databaseUrlRules).every(
    (key) => new URL(before.get(key)).password !== new URL(after.get(key)).password,
  );
  const directSecretsChanged = directSecretKeys.every((key) => before.get(key) !== after.get(key));
  const targetsUnchanged = [...Object.keys(expectedTarget), ...Object.keys(expectedOrigins)].every(
    (key) => before.get(key) === after.get(key),
  );

  assert.equal(databasePasswordsChanged, true);
  assert.equal(directSecretsChanged, true);
  assert.equal(targetsUnchanged, true);
  assert.equal(rotated.rotatedKeyCount, 8);
  assert.deepEqual(validateConfiguration(after, { template: false }), []);
});

test("rotation requires explicit confirmation before reading files or invoking Docker", async () => {
  let invoked = false;
  await assert.rejects(
    rotateLocalSecrets({
      confirmed: false,
      root: "unused",
      runner() {
        invoked = true;
        throw new Error("runner must not execute");
      },
    }),
    /explicit confirmation/i,
  );
  assert.equal(invoked, false);
});

test("rotation updates through stdin, retains old values only in callback memory, and has safe output", async () => {
  const root = await mkdtemp(join(tmpdir(), "agency-workload-rotation-"));
  const initial = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  await writeFile(join(root, ".env"), initial.text, "utf8");
  const invocations = [];
  let callbackVerified = false;

  try {
    const result = await rotateLocalSecrets({
      confirmed: true,
      now: 1_800_000_000,
      randomBytes: deterministicRandom(),
      root,
      runner(invocation) {
        invocations.push(invocation);
        if (invocation.command === "whoami") {
          return {
            status: 0,
            stdout: '"local\\tester","S-1-5-21-1000"\n',
          };
        }
        if (invocation.args?.includes("inspect")) {
          return {
            status: 0,
            stdout: "/project-postgres|postgres:16-alpine|true|5434\n",
          };
        }
        return { status: 0, stdout: "" };
      },
      async postRotationVerify({ currentValues, previousValues }) {
        callbackVerified = Object.keys(databaseUrlRules).every(
          (key) => previousValues.get(key) !== currentValues.get(key),
        );
      },
    });

    const after = parseEnv(await readFile(join(root, ".env"), "utf8"));
    const previous = parseEnv(initial.text);
    const allSecretValues = [
      ...directSecretKeys.flatMap((key) => [previous.get(key), after.get(key)]),
      ...Object.keys(databaseUrlRules).flatMap((key) => [
        previous.get(key),
        after.get(key),
        new URL(previous.get(key)).password,
        new URL(after.get(key)).password,
      ]),
    ];
    const output = rotationSummaryLines(result).join("\n");
    const processArguments = invocations.flatMap((invocation) => invocation.args ?? []).join(" ");

    assert.equal(callbackVerified, true);
    assert.equal(
      allSecretValues.every((value) => !output.includes(value)),
      true,
    );
    assert.equal(
      allSecretValues.every((value) => !processArguments.includes(value)),
      true,
    );
    assert.equal(
      invocations.some((invocation) => invocation.input?.includes("ALTER ROLE")),
      true,
    );
    assert.equal(result.rotatedKeyCount, 8);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("rotation restores database passwords and leaves .env unchanged when atomic replacement fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "agency-workload-rotation-rollback-"));
  const initial = createLocalEnvironment("", {
    now: 1_700_000_000,
    randomBytes: deterministicRandom(),
  });
  await writeFile(join(root, ".env"), initial.text, "utf8");
  const sqlInputs = [];

  try {
    await assert.rejects(
      rotateLocalSecrets({
        confirmed: true,
        now: 1_800_000_000,
        randomBytes: deterministicRandom(),
        root,
        runner(invocation) {
          if (invocation.args?.includes("inspect")) {
            return {
              status: 0,
              stdout: "/project-postgres|postgres:16-alpine|true|5434\n",
            };
          }
          if (invocation.command === "whoami") return { status: 0, stdout: "invalid identity" };
          if (invocation.input?.includes("ALTER ROLE")) sqlInputs.push(invocation.input);
          return { status: 0, stdout: "" };
        },
      }),
      /previous configuration remains active/i,
    );

    const originalRuntimePassword = new URL(parseEnv(initial.text).get("DATABASE_URL")).password;
    assert.equal(await readFile(join(root, ".env"), "utf8"), initial.text);
    assert.equal(sqlInputs.length, 2);
    assert.equal(sqlInputs[1].includes(originalRuntimePassword), true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("target validation refuses every unexpected shared-container setting", () => {
  const values = parseEnv(
    createLocalEnvironment("", { now: 1_700_000_000, randomBytes: deterministicRandom() }).text,
  );

  for (const key of [
    "AW_POSTGRES_CONTAINER",
    "AW_POSTGRES_SUPERUSER",
    "AW_POSTGRES_MAINTENANCE_DB",
    "AW_POSTGRES_HOST_PORT",
    "AW_DATABASE_NAME",
  ]) {
    const changed = new Map(values);
    changed.set(key, "unexpected-target");
    assert.throws(() => assertExpectedTarget(changed), new RegExp(key));
  }
});

test("psql invocations are fixed and never carry database passwords in arguments", () => {
  const invocation = psqlInvocation("mydb");

  assert.equal(invocation.command, "docker");
  assert.deepEqual(invocation.args, [
    "exec",
    "-i",
    "project-postgres",
    "psql",
    "--username",
    "myuser",
    "--dbname",
    "mydb",
    "--no-psqlrc",
    "--set",
    "ON_ERROR_STOP=1",
    "--quiet",
  ]);
  assert.doesNotMatch(invocation.args.join(" "), /password|postgresql:\/\//i);
});

test("rotation SQL changes only dedicated login-role passwords and probes use stdin", () => {
  const values = parseEnv(
    createLocalEnvironment("", { now: 1_700_000_000, randomBytes: deterministicRandom() }).text,
  );
  const sql = buildPasswordRotationSql(values);
  const probe = credentialProbeInvocation(values, { expectAuthentication: false });
  const currentProbe = credentialProbeInvocation(values, { expectAuthentication: true });

  assert.match(sql, /^\s*\\set ON_ERROR_STOP on\s+BEGIN;/);
  assert.match(sql, /ALTER ROLE agency_workload_runtime WITH PASSWORD/);
  assert.match(sql, /ALTER ROLE agency_workload_migrator WITH PASSWORD/);
  assert.match(sql, /ALTER ROLE supabase_auth_admin WITH PASSWORD/);
  assert.match(sql, /ALTER ROLE agency_workload_backup WITH PASSWORD/);
  assert.doesNotMatch(sql, /myuser|DROP|TRUNCATE|DELETE|ALTER (?:DATABASE|SCHEMA)/i);
  assert.deepEqual(probe.args, [
    "run",
    "--rm",
    "-i",
    "--add-host",
    "host.docker.internal:host-gateway",
    "postgres:16-alpine",
    "sh",
  ]);
  assert.match(probe.input, /\[ "\$authenticated" -eq 0 \]/);
  assert.match(currentProbe.input, /\[ "\$authenticated" -ne 0 \]/);
  assert.equal(
    Object.keys(databaseUrlRules).every((key) => !probe.args.join(" ").includes(values.get(key))),
    true,
  );
});

test("bootstrap SQL is idempotent, least-privilege, and contains no destructive data operation", () => {
  const values = parseEnv(
    createLocalEnvironment("", { now: 1_700_000_000, randomBytes: deterministicRandom() }).text,
  );
  const maintenanceSql = buildMaintenanceSql(values);
  const databaseSql = buildDatabaseSql(values);
  const allSql = `${maintenanceSql}\n${databaseSql}`;

  assert.match(maintenanceSql, /IF NOT EXISTS.*pg_roles/s);
  assert.match(maintenanceSql, /WHERE NOT EXISTS.*pg_database/s);
  assert.match(maintenanceSql, /CREATE ROLE postgres NOLOGIN NOSUPERUSER/);
  assert.match(maintenanceSql, /refusing elevated postgres compatibility role/);
  assert.match(databaseSql, /CREATE SCHEMA IF NOT EXISTS app/);
  assert.match(databaseSql, /CREATE SCHEMA IF NOT EXISTS auth/);
  assert.match(databaseSql, /REVOKE ALL ON SCHEMA public FROM PUBLIC/);
  assert.match(databaseSql, /GRANT USAGE ON SCHEMA app TO agency_workload_runtime/);
  assert.match(databaseSql, /ALTER DEFAULT PRIVILEGES FOR ROLE agency_workload_owner/);
  assert.match(databaseSql, /ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin/);
  assert.doesNotMatch(allSql, /DROP\s+(?:DATABASE|SCHEMA|TABLE)|TRUNCATE|DELETE\s+FROM/i);
});
