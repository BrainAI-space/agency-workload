import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createServiceRoleToken, parseEnv, validateConfiguration } from "../lib/config.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));

function runtimeConfiguration() {
  const jwtSecret = "j".repeat(64);
  return new Map([
    ["AW_POSTGRES_CONTAINER", "project-postgres"],
    ["AW_POSTGRES_SUPERUSER", "myuser"],
    ["AW_POSTGRES_MAINTENANCE_DB", "mydb"],
    ["AW_POSTGRES_HOST_PORT", "5434"],
    ["AW_DATABASE_NAME", "agency_workload"],
    ["APP_ORIGIN", "http://localhost:3100"],
    ["API_ORIGIN", "http://localhost:4100"],
    ["GOTRUE_ORIGIN", "http://127.0.0.1:9999"],
    ["MAILPIT_ORIGIN", "http://127.0.0.1:8025"],
    [
      "DATABASE_URL",
      `postgresql://agency_workload_runtime:${"r".repeat(40)}@127.0.0.1:5434/agency_workload`,
    ],
    [
      "MIGRATION_DATABASE_URL",
      `postgresql://agency_workload_migrator:${"m".repeat(40)}@127.0.0.1:5434/agency_workload`,
    ],
    [
      "GOTRUE_DATABASE_URL",
      `postgresql://supabase_auth_admin:${"a".repeat(40)}@host.docker.internal:5434/agency_workload`,
    ],
    [
      "BACKUP_DATABASE_URL",
      `postgresql://agency_workload_backup:${"b".repeat(40)}@127.0.0.1:5434/agency_workload`,
    ],
    ["GOTRUE_JWT_SECRET", jwtSecret],
    ["GOTRUE_SERVICE_ROLE_KEY", createServiceRoleToken(jwtSecret, { now: 1_700_000_000 })],
    ["PENDING_AUTH_KEY", "p".repeat(64)],
    ["SESSION_SECRET", "s".repeat(64)],
  ]);
}

test("parseEnv accepts comments and quoted values without leaking syntax into values", () => {
  const parsed = parseEnv("FIRST=one\n# ignored\nSECOND=\"two words\"\nTHIRD='three'\n");

  assert.deepEqual(
    [...parsed],
    [
      ["FIRST", "one"],
      ["SECOND", "two words"],
      ["THIRD", "three"],
    ],
  );
});

test("parseEnv rejects malformed and duplicate assignments", () => {
  assert.throws(() => parseEnv("NOT AN ASSIGNMENT\n"), /line 1/);
  assert.throws(() => parseEnv("DUPLICATE=one\nDUPLICATE=two\n"), /duplicate variable DUPLICATE/);
});

test("runtime configuration enforces exact targets and verifies the service token signature", () => {
  const valid = runtimeConfiguration();
  assert.deepEqual(validateConfiguration(valid, { template: false }), []);

  valid.set("APP_ORIGIN", "http://localhost:3100/wildcard/*");
  const sentinel = "DO_NOT_ECHO_THIS_VALUE_12345678901234567890";
  valid.set("DATABASE_URL", `postgresql://wrong:${sentinel}@127.0.0.1:5434/other`);
  valid.set("GOTRUE_SERVICE_ROLE_KEY", `${valid.get("GOTRUE_SERVICE_ROLE_KEY")}changed`);

  const failures = validateConfiguration(valid, { template: false });
  assert.ok(failures.some((failure) => failure.includes("APP_ORIGIN")));
  assert.ok(failures.some((failure) => failure.includes("DATABASE_URL")));
  assert.ok(failures.some((failure) => failure.includes("GOTRUE_SERVICE_ROLE_KEY")));
  assert.ok(failures.every((failure) => !failure.includes(sentinel)));
});

test("templates require obvious placeholders and prohibit browser-exposed variables", () => {
  const template = runtimeConfiguration();
  for (const key of [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "GOTRUE_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "GOTRUE_JWT_SECRET",
    "GOTRUE_SERVICE_ROLE_KEY",
    "PENDING_AUTH_KEY",
    "SESSION_SECRET",
  ]) {
    if (key.endsWith("DATABASE_URL") || key === "DATABASE_URL") {
      const url = new URL(template.get(key));
      url.password = "GENERATED_BY_LOCAL_BOOTSTRAP";
      template.set(key, url.toString());
    } else {
      template.set(key, "GENERATED_BY_LOCAL_BOOTSTRAP");
    }
  }

  assert.deepEqual(validateConfiguration(template, { template: true }), []);

  template.set("NEXT_PUBLIC_DATABASE_URL", "prohibited");
  assert.ok(
    validateConfiguration(template, { template: true }).some((failure) =>
      failure.includes("NEXT_PUBLIC_DATABASE_URL"),
    ),
  );
});

test("development Compose pins and hardens only GoTrue and Mailpit", async () => {
  const compose = await readFile(`${root}/infra/compose.dev.yml`, "utf8");

  assert.match(compose, /supabase\/gotrue:v2\.192\.0/);
  assert.match(compose, /axllent\/mailpit:v1\.30\.4/);
  assert.match(compose, /127\.0\.0\.1:9999:9999/);
  assert.match(compose, /127\.0\.0\.1:1025:1025/);
  assert.match(compose, /127\.0\.0\.1:8025:8025/);
  assert.match(compose, /GOTRUE_DISABLE_SIGNUP: "true"/);
  assert.match(compose, /GOTRUE_MAILER_AUTOCONFIRM: "false"/);
  assert.match(compose, /GOTRUE_EXTERNAL_PHONE_ENABLED: "false"/);
  assert.match(compose, /GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED: "false"/);
  assert.match(compose, /GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED: "true"/);
  assert.match(compose, /GOTRUE_SITE_URL: http:\/\/localhost:3100/);
  assert.match(compose, /GOTRUE_URI_ALLOW_LIST: http:\/\/localhost:3100\/auth\/confirm/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\s*\n\s+- ALL/);
  assert.match(compose, /networks:\s*\n\s+private:\s*\n\s+driver: bridge/);
  assert.doesNotMatch(compose, /external: true/);
  assert.doesNotMatch(compose, /zepto/i);
  assert.doesNotMatch(compose, /studio|postgrest|realtime|redis/i);
});
