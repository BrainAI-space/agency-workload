import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertExactAuthIntegrationBoundary,
  canonicalAuthTargetManifest,
  createAuthTargetProof,
  pollForRecipientOtp,
} from "../lib/auth-integration-boundary.mjs";
import { dockerResourceListInvocation } from "../lib/browser-smoke-docker.mjs";
import {
  AUTH_INTEGRATION_CLEANUP_BUDGET_MS,
  AUTH_INTEGRATION_MAIN_BUDGET_MS,
  AUTH_PORT_MAX,
  AUTH_PORT_MIN,
  allocateDistinctAuthPorts,
  createAuthRunIdentity,
  createOperationDeadline,
  probeAuthPort,
  runBudgetedStartupSequence,
  runCommandWithinDeadline,
  validateAuthPorts,
} from "../lib/disposable-auth-integration.mjs";
import {
  buildAuthIntegrationEnvironment,
  createSmokeConfiguration,
  createSmokeIdentity,
} from "../lib/disposable-browser-smoke.mjs";
import {
  CANONICAL_SYNC_ONLY_MESSAGE,
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
  runPublicMirrorCommand,
} from "../public-mirror-command.mjs";

const suffix = "0123456789abcdef0123456789abcdef";
const identity = createSmokeIdentity(suffix);
const ports = {
  postgres: 52_000,
  web: 52_001,
  api: 52_002,
  gotrue: 52_003,
  smtp: 52_004,
  mailpit: 52_005,
};
const baseEnvironment = {
  AW_POSTGRES_HOST_PORT: "5434",
  APP_ORIGIN: "http://localhost:3100",
  API_ORIGIN: "http://localhost:4100",
  GOTRUE_ORIGIN: "http://127.0.0.1:9999",
  MAILPIT_ORIGIN: "http://127.0.0.1:8025",
  PATH: "system-path",
  SMTP_PORT: "1025",
};
const randomBytes = (size) => Buffer.alloc(size, 11);

function authEnvironment() {
  const configuration = createSmokeConfiguration(identity, ports, {
    now: 1_800_000_000,
    randomBytes,
  });
  return buildAuthIntegrationEnvironment(configuration, baseEnvironment, {
    runToken: `${suffix}${"c".repeat(32)}`,
  });
}

test("auth identity and target names derive from the fixed run-token prefix", () => {
  const token = `${suffix}${"c".repeat(32)}`;
  const derived = createAuthRunIdentity(token);
  assert.equal(derived.suffix, suffix);
  assert.equal(derived.databaseName, `agency_workload_smoke_${suffix}`);
  assert.equal(derived.composeProject, `agency-workload-smoke-${suffix}`);
  assert.equal(derived.marker, `agency-workload-smoke-${suffix}-auth`);
  assert.throws(() => createAuthRunIdentity("bad-token"), /token/i);
});

test("auth integration environment contains only disposable service targets and marker", () => {
  const environment = authEnvironment();
  assert.equal(environment.AW_AUTH_INTEGRATION, "1");
  assert.equal(environment.AW_DISPOSABLE_COMPOSE_PROJECT, identity.composeProject);
  assert.equal(environment.AW_DISPOSABLE_TEST_MARKER, identity.processMarkers.auth);
  assert.match(environment.AW_DISPOSABLE_TEST_MARKER, /^agency-workload-smoke-[a-f0-9]{32}-auth$/);
  assert.equal(new URL(environment.DATABASE_URL).port, String(ports.postgres));
  assert.equal(new URL(environment.DATABASE_URL).pathname, `/${identity.databaseName}`);
  assert.equal(new URL(environment.GOTRUE_DATABASE_URL).hostname, "127.0.0.1");
  assert.equal(new URL(environment.GOTRUE_DATABASE_URL).port, String(ports.postgres));
  assert.equal(new URL(environment.GOTRUE_ORIGIN).port, String(ports.gotrue));
  assert.equal(new URL(environment.MAILPIT_ORIGIN).port, String(ports.mailpit));
  assert.notEqual(new URL(environment.DATABASE_URL).pathname, "/agency_workload");
  assert.notEqual(new URL(environment.GOTRUE_ORIGIN).port, "9999");
  assert.notEqual(new URL(environment.MAILPIT_ORIGIN).port, "8025");
  for (const key of ["MIGRATION_DATABASE_URL", "SMOKE_POSTGRES_PASSWORD", "DOCKER_HOST"]) {
    assert.equal(environment[key], undefined);
  }
  assert.doesNotThrow(() => assertExactAuthIntegrationBoundary(environment));
  const manifest = canonicalAuthTargetManifest(environment);
  assert.equal(typeof manifest, "string");
  assert.equal(environment.AW_DISPOSABLE_TARGET_PROOF.length, 64);
});

test("exact auth boundary rejects alternate targets, options, SMTP, token, and marker", () => {
  const valid = authEnvironment();
  const signed = (overrides) => {
    const environment = { ...valid, ...overrides };
    environment.AW_DISPOSABLE_TARGET_PROOF = createAuthTargetProof(
      environment.AW_DISPOSABLE_RUN_TOKEN,
      canonicalAuthTargetManifest(environment),
    );
    return environment;
  };
  const cases = [
    signed({ DATABASE_URL: valid.DATABASE_URL.replace(`:${ports.postgres}/`, ":52199/") }),
    signed({ DATABASE_URL: `${valid.DATABASE_URL}?host=remote.invalid` }),
    signed({
      AW_EXPECTED_DATABASE_URL: `${valid.AW_EXPECTED_DATABASE_URL}?host=remote.invalid`,
      DATABASE_URL: `${valid.DATABASE_URL}?host=remote.invalid`,
    }),
    signed({ DATABASE_URL: valid.DATABASE_URL.replace("agency_workload_runtime", "wrong") }),
    signed({ DATABASE_URL: valid.DATABASE_URL.replace(identity.databaseName, "wrong_database") }),
    signed({ GOTRUE_DATABASE_URL: `${valid.GOTRUE_DATABASE_URL}?options=-csearch_path%3Dpublic` }),
    signed({
      AW_EXPECTED_GOTRUE_DATABASE_URL: `${valid.AW_EXPECTED_GOTRUE_DATABASE_URL}?options=-csearch_path%3Dpublic`,
      GOTRUE_DATABASE_URL: `${valid.GOTRUE_DATABASE_URL}?options=-csearch_path%3Dpublic`,
    }),
    signed({
      GOTRUE_DATABASE_URL: valid.GOTRUE_DATABASE_URL.replace("127.0.0.1", "remote.invalid"),
    }),
    signed({
      GOTRUE_DATABASE_URL: valid.GOTRUE_DATABASE_URL.replace("supabase_auth_admin", "wrong"),
    }),
    signed({ GOTRUE_ORIGIN: valid.GOTRUE_ORIGIN.replace(`:${ports.gotrue}`, ":52198") }),
    signed({ MAILPIT_ORIGIN: valid.MAILPIT_ORIGIN.replace(`:${ports.mailpit}`, ":52197") }),
    signed({ SMTP_PORT: "1025" }),
    signed({ AW_DISPOSABLE_COMPOSE_PROJECT: "agency-workload-smoke-wrong" }),
    signed({ AW_DISPOSABLE_TEST_MARKER: `agency-workload-smoke-${"d".repeat(32)}-auth` }),
    { ...valid, AW_DISPOSABLE_RUN_TOKEN: "" },
    { ...valid, AW_DISPOSABLE_TARGET_PROOF: "0".repeat(64) },
    signed({ AW_EXPECTED_DATABASE_NAME: "agency_workload_smoke_deadbeefdeadbeefdeadbeefdeadbeef" }),
    signed({
      AW_EXPECTED_DATABASE_PORT: "5434",
      AW_EXPECTED_DATABASE_URL: valid.AW_EXPECTED_DATABASE_URL.replace(
        `:${ports.postgres}/`,
        ":5434/",
      ),
      AW_EXPECTED_GOTRUE_DATABASE_URL: valid.AW_EXPECTED_GOTRUE_DATABASE_URL.replace(
        `:${ports.postgres}/`,
        ":5434/",
      ),
      DATABASE_URL: valid.DATABASE_URL.replace(`:${ports.postgres}/`, ":5434/"),
      GOTRUE_DATABASE_URL: valid.GOTRUE_DATABASE_URL.replace(`:${ports.postgres}/`, ":5434/"),
    }),
    signed({
      AW_EXPECTED_GOTRUE_ORIGIN: "http://127.0.0.1:9999",
      AW_EXPECTED_GOTRUE_PORT: "9999",
      GOTRUE_ORIGIN: "http://127.0.0.1:9999",
    }),
    signed({
      AW_EXPECTED_MAILPIT_ORIGIN: "http://127.0.0.1:8025",
      AW_EXPECTED_MAILPIT_PORT: "8025",
      MAILPIT_ORIGIN: "http://127.0.0.1:8025",
    }),
    signed({ AW_EXPECTED_SMTP_PORT: "1025", SMTP_PORT: "1025" }),
    signed({
      AW_EXPECTED_SMTP_PORT: valid.AW_EXPECTED_MAILPIT_PORT,
      SMTP_PORT: valid.AW_EXPECTED_MAILPIT_PORT,
    }),
    signed({
      AW_EXPECTED_SMTP_PORT: String(AUTH_PORT_MIN - 1),
      SMTP_PORT: String(AUTH_PORT_MIN - 1),
    }),
    signed({
      AW_EXPECTED_SMTP_PORT: String(AUTH_PORT_MAX + 1),
      SMTP_PORT: String(AUTH_PORT_MAX + 1),
    }),
  ];
  for (const environment of cases) {
    assert.throws(
      () => assertExactAuthIntegrationBoundary(environment),
      /Disposable auth integration/,
    );
  }
});

test("auth target proof changes with any canonical expected field", () => {
  const environment = authEnvironment();
  const original = createAuthTargetProof(
    environment.AW_DISPOSABLE_RUN_TOKEN,
    canonicalAuthTargetManifest(environment),
  );
  const changed = {
    ...environment,
    AW_EXPECTED_SMTP_PORT: String(Number(environment.AW_EXPECTED_SMTP_PORT) + 1),
  };
  assert.notEqual(
    original,
    createAuthTargetProof(changed.AW_DISPOSABLE_RUN_TOKEN, canonicalAuthTargetManifest(changed)),
  );
});

test("auth ports require distinct high ephemeral values and reject defaults", () => {
  const valid = {
    postgres: AUTH_PORT_MIN,
    gotrue: AUTH_PORT_MIN + 1,
    mailpit: AUTH_PORT_MIN + 2,
    smtp: AUTH_PORT_MIN + 3,
  };
  assert.doesNotThrow(() => validateAuthPorts(valid));
  assert.throws(() => validateAuthPorts({ ...valid, smtp: valid.mailpit }), /distinct/i);
  assert.throws(() => validateAuthPorts({ ...valid, smtp: 1025 }), /range|persistent/i);
  assert.throws(() => validateAuthPorts({ ...valid, gotrue: 9999 }), /range|persistent/i);
  assert.throws(() => validateAuthPorts({ ...valid, postgres: 5434 }), /range|persistent/i);
  assert.throws(() => validateAuthPorts({ ...valid, mailpit: 8025 }), /range|persistent/i);
});

test("auth allocator retries a failed bind and accepts the next valid candidate", async () => {
  const candidates = [52_100, 52_101];
  const probes = [];
  const ports = await allocateDistinctAuthPorts({
    attemptsPerPort: 4,
    candidateSource: () => candidates.shift(),
    deadline: createOperationDeadline({ budgetMs: 1_000, now: () => 0 }),
    keys: ["postgres"],
    persistentPorts: new Set(),
    probe: async (candidate) => {
      probes.push(candidate);
      if (candidate === 52_100) {
        const error = new Error("bind failed");
        error.code = "EADDRINUSE";
        throw error;
      }
      return true;
    },
  });
  assert.deepEqual(ports, { postgres: 52_101 });
  assert.deepEqual(probes, [52_100, 52_101]);
});

test("auth allocator exhausts bounded attempts with a fixed error", async () => {
  let attempts = 0;
  await assert.rejects(
    allocateDistinctAuthPorts({
      attemptsPerPort: 3,
      candidateSource: () => 52_110 + attempts,
      deadline: createOperationDeadline({ budgetMs: 1_000, now: () => 0 }),
      keys: ["postgres"],
      persistentPorts: new Set(),
      probe: async () => {
        attempts += 1;
        const error = new Error("excluded range");
        error.code = "EACCES";
        throw error;
      },
    }),
    /could not allocate isolated ports/i,
  );
  assert.equal(attempts, 3);
});

test("undefined candidates never exit the retry loop", async () => {
  const candidates = [undefined, undefined, 52_120];
  let probes = 0;
  const result = await allocateDistinctAuthPorts({
    attemptsPerPort: 3,
    candidateSource: () => candidates.shift(),
    deadline: createOperationDeadline({ budgetMs: 1_000, now: () => 0 }),
    keys: ["postgres"],
    persistentPorts: new Set(),
    probe: async () => {
      probes += 1;
      return true;
    },
  });
  assert.deepEqual(result, { postgres: 52_120 });
  assert.equal(probes, 1);
});

test("auth allocator never returns a duplicate candidate", async () => {
  const candidates = [52_130, 52_130, 52_131];
  const result = await allocateDistinctAuthPorts({
    attemptsPerPort: 3,
    candidateSource: () => candidates.shift(),
    deadline: createOperationDeadline({ budgetMs: 1_000, now: () => 0 }),
    keys: ["postgres", "smtp"],
    persistentPorts: new Set(),
    probe: async () => true,
  });
  assert.deepEqual(result, { postgres: 52_130, smtp: 52_131 });
});

test("auth allocator propagates timeout instead of retrying", async () => {
  let attempts = 0;
  await assert.rejects(
    allocateDistinctAuthPorts({
      attemptsPerPort: 4,
      candidateSource: () => 52_140 + attempts,
      deadline: createOperationDeadline({ budgetMs: 1_000, now: () => 0 }),
      keys: ["postgres"],
      persistentPorts: new Set(),
      probe: async () => {
        attempts += 1;
        const error = new Error("deadline");
        error.safeCategory = "timeout";
        throw error;
      },
    }),
    (error) => {
      assert.equal(error.safeCategory, "timeout");
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test("auth port probe clears timer and closes safely on bind errors", async () => {
  const events = [];
  const listeners = new Map();
  const server = {
    close(callback) {
      events.push("close");
      callback?.();
    },
    listen() {
      const error = new Error("excluded range");
      error.code = "EACCES";
      listeners.get("error")?.(error);
    },
    once(name, listener) {
      listeners.set(name, listener);
      return this;
    },
    removeAllListeners() {
      listeners.clear();
    },
    unref() {
      events.push("unref");
    },
  };
  await assert.rejects(
    probeAuthPort(52_150, createOperationDeadline({ budgetMs: 1_000, now: () => 0 }), {
      clearTimer: () => events.push("clear-timer"),
      createServer: () => server,
      setTimer: () => 1,
    }),
    (error) => error.code === "EACCES",
  );
  assert.deepEqual(events, ["unref", "clear-timer", "close"]);
});

test("Docker resource list commands use supported fields for each resource", () => {
  const project = "agency-workload-smoke-0123456789abcdef0123456789abcdef";
  assert.deepEqual(dockerResourceListInvocation("container", project), {
    command: "docker",
    args: [
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${project}`,
      "--format",
      "{{.ID}}",
    ],
  });
  assert.deepEqual(dockerResourceListInvocation("network", project).args, [
    "network",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.ID}}",
  ]);
  assert.deepEqual(dockerResourceListInvocation("volume", project).args, [
    "volume",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--format",
    "{{.Name}}",
  ]);
  assert.throws(() => dockerResourceListInvocation("image", project), /resource type/i);
});

test("local Docker accepts every resource list format without mutation", () => {
  const project = `agency-workload-list-test-${process.pid}-${Date.now()}`;
  for (const resource of ["container", "network", "volume"]) {
    const invocation = dockerResourceListInvocation(resource, project);
    const result = spawnSync(invocation.command, invocation.args, {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    assert.equal(result.status, 0, `${resource} list command failed`);
    assert.equal(result.stdout.trim(), "");
  }
});

test("OTP polling uses one five-second deadline and cancels every bounded fetch", async () => {
  let currentTime = 0;
  const signals = [];
  await assert.rejects(
    pollForRecipientOtp({
      deadlineMs: 5_000,
      fetchImpl: async (_url, options) => {
        signals.push(options.signal);
        return {
          json: async () => ({ messages: [], total: 0 }),
          ok: true,
          text: async () => "",
        };
      },
      mailpitOrigin: "http://127.0.0.1:52005",
      now: () => currentTime,
      recipient: "nobody@agency-workload.local",
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    }),
    (error) => {
      assert.equal(error.message, "Disposable Mailpit OTP deadline exceeded");
      return true;
    },
  );
  assert.equal(currentTime, 5_000);
  assert.ok(signals.length > 0);
  assert.equal(
    signals.every((signal) => signal.aborted),
    true,
  );
});

test("OTP polling aborts a hanging fetch within the overall deadline", async () => {
  const startedAt = Date.now();
  let aborts = 0;
  await assert.rejects(
    pollForRecipientOtp({
      deadlineMs: 200,
      fetchImpl: async (_url, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            "abort",
            () => {
              aborts += 1;
              reject(new DOMException("This operation was aborted", "AbortError"));
            },
            { once: true },
          );
        }),
      mailpitOrigin: "http://127.0.0.1:52005",
      recipient: "nobody@agency-workload.local",
    }),
    (error) => {
      assert.equal(error.message, "Disposable Mailpit OTP deadline exceeded");
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 1_000);
  assert.ok(aborts >= 1);
});

test("auth child has no timeout or kill and parent owns one whole-operation budget", async () => {
  const [child, parent] = await Promise.all([
    readFile(new URL("../run-auth-integration-child.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/disposable-auth-integration.mjs", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(child, /timeout\s*:|taskkill|SIGKILL|\.kill\(/);
  assert.match(parent, /waitForManagedChild/);
  assert.equal(AUTH_INTEGRATION_MAIN_BUDGET_MS, 180_000);
  assert.equal(AUTH_INTEGRATION_CLEANUP_BUDGET_MS, 30_000);
  assert.doesNotMatch(parent, /AUTH_INTEGRATION_OUTER_BUDGET_MS/);
  assert.match(parent, /const mainDeadline = createOperationDeadline/);
  assert.match(parent, /const cleanupDeadline = createOperationDeadline/);
  assert.match(parent, /await cleanupOnce\(\)/);
});

test("command timeout shrinks to remaining main budget and never exceeds it", () => {
  let now = 1_000;
  const deadline = createOperationDeadline({ budgetMs: 1_000, now: () => now });
  const observed = [];
  const execute = (_command, _args, options) => {
    observed.push(options.timeout);
    return { status: 0, stdout: "ok" };
  };
  assert.equal(
    runCommandWithinDeadline({
      args: [],
      command: "docker",
      deadline,
      environment: {},
      execute,
      stepTimeoutMs: 900,
    }),
    "ok",
  );
  now = 1_750;
  runCommandWithinDeadline({
    args: [],
    command: "docker",
    deadline,
    environment: {},
    execute,
    stepTimeoutMs: 900,
  });
  assert.deepEqual(observed, [900, 250]);
});

test("early setup timeout skips later creation and always completes separate cleanup", async () => {
  let now = 0;
  const deadline = createOperationDeadline({ budgetMs: 100, now: () => now });
  const events = [];
  await assert.rejects(
    runBudgetedStartupSequence({
      cleanup: async () => {
        events.push("cleanup-start");
        now += 10_000;
        events.push("cleanup-finish");
      },
      deadline,
      steps: [
        async () => {
          events.push("compose-created");
          now = 101;
        },
        async () => events.push("later-resource-created"),
      ],
    }),
    (error) => {
      assert.equal(error.safeCategory, "timeout");
      return true;
    },
  );
  assert.deepEqual(events, ["compose-created", "cleanup-start", "cleanup-finish"]);
});

test("exhausted command budget throws fixed timeout before execution", () => {
  let now = 0;
  const deadline = createOperationDeadline({ budgetMs: 10, now: () => now });
  now = 11;
  let executed = false;
  assert.throws(
    () =>
      runCommandWithinDeadline({
        args: [],
        command: "docker",
        deadline,
        environment: {},
        execute: () => {
          executed = true;
          return { status: 0 };
        },
        stepTimeoutMs: 100,
      }),
    (error) => {
      assert.equal(error.safeCategory, "timeout");
      return true;
    },
  );
  assert.equal(executed, false);
});

test("public tooling and private allowlist match the exact repository origin", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const origin = readExactOrigin(root);

  if (origin === PRIVATE_CANONICAL_ORIGIN) {
    const allowlist = JSON.parse(
      await readFile(new URL("../public-files.json", import.meta.url), "utf8"),
    ).include;
    for (const path of [
      "tools/lib",
      "tools/public-mirror-command.mjs",
      "tools/run-auth-integration.mjs",
      "tools/run-auth-integration-child.mjs",
      "tools/test",
    ]) {
      assert.ok(allowlist.includes(path));
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

test("auth integration runner and test prohibit persistent targets and row cleanup", async () => {
  const [runner, integration, boundary, harness, shared, child, manifest] = await Promise.all([
    readFile(new URL("../run-auth-integration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../apps/api/test/auth.integration.test.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth-integration-boundary.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/disposable-auth-integration.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/disposable-browser-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../run-auth-integration-child.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  assert.equal(
    JSON.parse(manifest).scripts["test:auth:integration"],
    "node tools/run-auth-integration.mjs",
  );
  assert.match(runner, /runDisposableAuthIntegration/);
  assert.match(runner, /auth\.integration\.test\.ts/);
  assert.doesNotMatch(runner, /project-postgres|127\.0\.0\.1:(?:5434|9999|8025)/);
  assert.match(integration, /assertExactAuthIntegrationBoundary/);
  assert.match(boundary, /AW_DISPOSABLE_TEST_MARKER/);
  assert.match(integration, /MAILPIT_ORIGIN/);
  assert.doesNotMatch(
    `${runner}\n${harness}\n${shared}\n${child}`,
    /--env-file|loadEnvFile|dotenv|readFile[^\n]*\.env/,
  );
  assert.doesNotMatch(`${runner}\n${harness}`, /persistentPortsFromEnvironment/);
  assert.doesNotMatch(integration, /127\.0\.0\.1:8025|message\/latest\/raw/);
  assert.doesNotMatch(
    integration,
    /session_replication_role|project-postgres|execFileSync|\/admin\/users\/.*DELETE/i,
  );
});

test("auth integration source refuses a missing disposable marker", async () => {
  const [integration, boundary] = await Promise.all([
    readFile(new URL("../../apps/api/test/auth.integration.test.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/auth-integration-boundary.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(integration, /assertExactAuthIntegrationBoundary/);
  assert.match(boundary, /AW_DISPOSABLE_TEST_MARKER/);
  assert.ok(
    integration.indexOf("assertExactAuthIntegrationBoundary") < integration.indexOf("new Pool"),
  );
  assert.ok(
    integration.indexOf("assertExactAuthIntegrationBoundary") < integration.indexOf("clearMail"),
  );
});

test("auth integration exits before configuration when disposable marker is missing", () => {
  const environment = { ...authEnvironment() };
  delete environment.AW_DISPOSABLE_TEST_MARKER;
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      "import('./apps/api/test/auth.integration.test.ts')",
    ],
    {
      encoding: "utf8",
      env: {
        ...environment,
        AW_AUTH_INTEGRATION: "1",
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      },
      timeout: 10_000,
      windowsHide: true,
    },
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Disposable auth integration expected target is missing: AW_DISPOSABLE_TEST_MARKER/,
  );
  assert.doesNotMatch(result.stderr, /postgresql:\/\/|Bearer |eyJ/);
});
