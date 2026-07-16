import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertDockerEndpointOverridesSafe,
  assertLocalDockerEndpoint,
  assertNoDockerControls,
  dockerContextInspectInvocation,
} from "../lib/browser-smoke-docker.mjs";
import {
  appendBoundedNetworkEvidence,
  assertDestinationRequestsCompleted,
  assertNetworkHealthy,
  completionSnapshot,
  createNetworkState,
  recordApiResponse,
  recordApiTransportFailure,
  requiredSchedulePaths,
} from "../lib/browser-smoke-network.mjs";
import {
  createIdempotentCleanup,
  createShutdownCoordinator,
  filterExactWindowsMarkerProcesses,
  installSignalHandlers,
  managedSpawnOptions,
  processTerminationAction,
  runStartupStep,
  stopManagedProcessTree,
  terminateWindowsMarkerProcesses,
  waitForManagedChild,
} from "../lib/browser-smoke-process.mjs";
import { assertExactHealthBody, assertReadinessMetadata } from "../lib/browser-smoke-readiness.mjs";
import {
  assertDisposablePorts,
  assertSmokeIdentity,
  buildChildEnvironments,
  buildInitializeClusterSql,
  buildInitializeDatabaseSql,
  createSmokeConfiguration,
  createSmokeIdentity,
  disposablePsqlInvocation,
  persistentPortExclusions,
} from "../lib/disposable-browser-smoke.mjs";

const suffix = "0123456789abcdef0123456789abcdef";
const identity = createSmokeIdentity(suffix);
const ports = {
  postgres: 32100,
  web: 32101,
  api: 32102,
  gotrue: 32103,
  smtp: 32104,
  mailpit: 32105,
};
const deterministicRandom = (size) => Buffer.alloc(size, 7);

test("smoke identity owns PostgreSQL, GoTrue, Mailpit, network, and volume names", () => {
  assert.doesNotThrow(() => assertSmokeIdentity(identity));
  assert.equal(identity.databaseName, `agency_workload_smoke_${suffix}`);
  assert.equal(identity.containers.postgres, `${identity.composeProject}-postgres-1`);
  assert.equal(identity.containers.gotrue, `${identity.composeProject}-gotrue-1`);
  assert.equal(identity.containers.mailpit, `${identity.composeProject}-mailpit-1`);
  assert.equal(identity.networkName, `${identity.composeProject}_private`);
  assert.equal(identity.hostNetworkName, `${identity.composeProject}_host-access`);
  assert.equal(identity.volumeName, `${identity.composeProject}_postgres-data`);
  assert.throws(() => createSmokeIdentity("../unsafe"), /suffix/i);
  assert.throws(
    () => assertSmokeIdentity({ ...identity, volumeName: "shared-volume" }),
    /resource/i,
  );
});

test("persistent port exclusions are fixed without reading environment configuration", () => {
  assert.deepEqual(
    [...persistentPortExclusions()].sort((left, right) => left - right),
    [1025, 3100, 4100, 5432, 5434, 8025, 9999],
  );
});

test("Docker context inspection is fixed and accepts only local transports", () => {
  assert.deepEqual(dockerContextInspectInvocation(), {
    command: "docker",
    args: ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
  });
  assert.doesNotThrow(() =>
    assertLocalDockerEndpoint("npipe:////./pipe/dockerDesktopLinuxEngine", "win32"),
  );
  assert.doesNotThrow(() => assertLocalDockerEndpoint("unix:///var/run/docker.sock", "linux"));
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "tcp://remote.example:2376",
    "ssh://operator@example.invalid",
    "https://docker.example.invalid",
    "http://127.0.0.1:2375",
    "npipe://remote/pipe/docker",
    "unix://relative.sock",
    " malformed ",
  ]) {
    assert.throws(() => assertLocalDockerEndpoint(endpoint, "win32"), /Docker context/i);
    assert.throws(() => assertLocalDockerEndpoint(endpoint, "linux"), /Docker context/i);
  }
});

test("Docker endpoint overrides are rejected before CLI use", () => {
  assert.doesNotThrow(() => assertDockerEndpointOverridesSafe({}));
  assert.throws(
    () => assertDockerEndpointOverridesSafe({ DOCKER_HOST: "tcp://remote.example:2376" }),
    /DOCKER_HOST/,
  );
  assert.throws(
    () => assertDockerEndpointOverridesSafe({ DOCKER_CONTEXT: "remote-context" }),
    /DOCKER_CONTEXT/,
  );
});

test("smoke ports are unique and cannot reuse persistent service ports", () => {
  const persistent = persistentPortExclusions();
  assert.doesNotThrow(() => assertDisposablePorts(ports, persistent));
  assert.throws(
    () => assertDisposablePorts({ ...ports, mailpit: 8025 }, persistent),
    /persistent/i,
  );
  assert.throws(() => assertDisposablePorts({ ...ports, api: ports.web }, persistent), /unique/i);
  assert.throws(() => assertDisposablePorts({ ...ports, postgres: 0 }, persistent), /port/i);
});

test("smoke configuration generates independent credentials and disposable URLs", () => {
  const configuration = createSmokeConfiguration(identity, ports, {
    now: 1_800_000_000,
    randomBytes: deterministicRandom,
  });
  assert.equal(new URL(configuration.runtimeDatabaseUrl).hostname, "127.0.0.1");
  assert.equal(new URL(configuration.runtimeDatabaseUrl).port, String(ports.postgres));
  assert.equal(new URL(configuration.runtimeDatabaseUrl).pathname, `/${identity.databaseName}`);
  assert.equal(new URL(configuration.gotrueDatabaseUrl).hostname, "postgres");
  assert.equal(new URL(configuration.gotrueDatabaseUrl).port, "5432");
  assert.equal(new URL(configuration.gotrueOrigin).port, String(ports.gotrue));
  assert.equal(new URL(configuration.mailpitOrigin).port, String(ports.mailpit));
  assert.equal(configuration.bootstrapEmail, identity.bootstrapEmail);
  assert.notEqual(configuration.runtimePassword, configuration.migratorPassword);
  assert.notEqual(configuration.authPassword, configuration.postgresPassword);
  assert.doesNotMatch(JSON.stringify(configuration), /runtime-secret|migration-secret|auth-secret/);
});

test("disposable PostgreSQL SQL creates only dedicated roles and the disposable database", () => {
  const configuration = createSmokeConfiguration(identity, ports, {
    now: 1_800_000_000,
    randomBytes: deterministicRandom,
  });
  const clusterSql = buildInitializeClusterSql(configuration, identity);
  const databaseSql = buildInitializeDatabaseSql();
  assert.match(clusterSql, new RegExp(`CREATE DATABASE "${identity.databaseName}"`));
  assert.match(clusterSql, /CREATE ROLE agency_workload_runtime WITH LOGIN/);
  assert.match(clusterSql, /CREATE ROLE supabase_auth_admin WITH LOGIN/);
  assert.match(clusterSql, /CREATE ROLE postgres WITH NOLOGIN/);
  assert.doesNotMatch(clusterSql, /project-postgres|\bmydb\b|DROP DATABASE|TRUNCATE/);
  assert.match(databaseSql, /CREATE SCHEMA app AUTHORIZATION agency_workload_owner/);
  assert.match(databaseSql, /CREATE SCHEMA auth AUTHORIZATION supabase_auth_admin/);
  assert.doesNotMatch(databaseSql, /DROP DATABASE|TRUNCATE|DELETE FROM/);
});

test("psql uses Compose exec against only the disposable postgres service", () => {
  assert.deepEqual(disposablePsqlInvocation(identity, "postgres"), {
    command: "docker",
    args: [
      "compose",
      "--project-name",
      identity.composeProject,
      "-f",
      "COMPOSE_FILE",
      "exec",
      "-T",
      "postgres",
      "psql",
      "--username",
      "smoke_admin",
      "--dbname",
      "postgres",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
  });
  assert.equal(disposablePsqlInvocation(identity, "application").args[12], identity.databaseName);
  assert.throws(() => disposablePsqlInvocation(identity, "agency_workload"), /target/i);
});

test("child environments are explicit and least privilege", () => {
  const configuration = createSmokeConfiguration(identity, ports, {
    now: 1_800_000_000,
    randomBytes: deterministicRandom,
  });
  const child = buildChildEnvironments(configuration, {
    COMPOSE_FILE: "unsafe-compose-file",
    DOCKER_CERT_PATH: "unsafe-cert-path",
    DOCKER_CONFIG: "docker-config",
    DOCKER_CONTEXT: "remote-context",
    DOCKER_HOST: "tcp://remote.example:2376",
    PATH: "system-path",
    USERPROFILE: "profile",
    DATABASE_URL: "persistent-runtime",
    MIGRATION_DATABASE_URL: "persistent-migrator",
    GOTRUE_SERVICE_ROLE_KEY: "persistent-service-key",
    SESSION_SECRET: "persistent-session",
  });
  const browserForbidden = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "GOTRUE_DATABASE_URL",
    "BACKUP_DATABASE_URL",
    "GOTRUE_JWT_SECRET",
    "GOTRUE_SERVICE_ROLE_KEY",
    "SESSION_SECRET",
    "PENDING_AUTH_KEY",
    "SMOKE_POSTGRES_PASSWORD",
  ];
  for (const key of browserForbidden) assert.equal(child.browser[key], undefined);
  assert.deepEqual(
    Object.keys(child.browser)
      .filter((key) => !["PATH", "USERPROFILE"].includes(key))
      .sort(),
    [
      "APP_ORIGIN",
      "BOOTSTRAP_EMAIL",
      "MAILPIT_ORIGIN",
      "SMOKE_BROWSER_PROFILE",
      "SMOKE_PROCESS_MARKER",
    ],
  );
  assert.equal(child.web.DATABASE_URL, undefined);
  assert.equal(child.web.GOTRUE_SERVICE_ROLE_KEY, undefined);
  assert.equal(child.api.MIGRATION_DATABASE_URL, undefined);
  assert.equal(child.api.SMOKE_POSTGRES_PASSWORD, undefined);
  assert.equal(child.migration.DATABASE_URL, undefined);
  assert.equal(child.migration.MIGRATION_DATABASE_URL, configuration.migrationDatabaseUrl);
  assert.equal(child.compose.SMOKE_POSTGRES_PASSWORD, configuration.postgresPassword);
  assert.equal(child.compose.COMPOSE_DISABLE_ENV_FILE, "true");
  assert.equal(child.docker.COMPOSE_DISABLE_ENV_FILE, "true");
  assert.equal(child.docker.DOCKER_CONFIG, "docker-config");
  for (const name of ["api", "web", "browser", "bootstrap", "migration", "webBuild"]) {
    assert.doesNotThrow(() => assertNoDockerControls(child[name]));
  }
});

test("cleanup wrapper is idempotent", async () => {
  let calls = 0;
  const cleanup = createIdempotentCleanup(async () => {
    calls += 1;
    await Promise.resolve();
    return "clean";
  });
  const [first, second, third] = await Promise.all([cleanup(), cleanup(), cleanup()]);
  assert.equal(calls, 1);
  assert.equal(first, "clean");
  assert.equal(second, "clean");
  assert.equal(third, "clean");
});

test("signal handlers await shared cleanup and use conventional exit codes", async () => {
  const target = new EventEmitter();
  const events = [];
  const remove = installSignalHandlers({
    cleanup: async () => events.push("cleanup"),
    exit: (code) => events.push(`exit-${code}`),
    target,
  });
  assert.equal(target.listenerCount("SIGINT"), 1);
  assert.equal(target.listenerCount("SIGTERM"), 1);
  target.emit("SIGINT");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["cleanup", "exit-130"]);
  remove();
  assert.equal(target.listenerCount("SIGINT"), 0);
  assert.equal(target.listenerCount("SIGTERM"), 0);
});

test("signal handlers persist, ignore repeats, and fail nonzero when cleanup fails", async () => {
  const target = new EventEmitter();
  const events = [];
  let releaseCleanup;
  const cleanupGate = new Promise((resolve) => {
    releaseCleanup = resolve;
  });
  const remove = installSignalHandlers({
    cleanup: async () => {
      events.push("cleanup");
      await cleanupGate;
      throw new Error("cleanup failed");
    },
    exit: (code) => events.push(`exit-${code}`),
    target,
  });
  target.emit("SIGTERM");
  target.emit("SIGINT");
  assert.equal(target.listenerCount("SIGINT"), 1);
  assert.equal(target.listenerCount("SIGTERM"), 1);
  releaseCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["cleanup", "exit-1"]);
  remove();
});

test("signal during delayed startup prevents later creation and cleanup sees live resources", async () => {
  const target = new EventEmitter();
  const resources = [];
  const events = [];
  let releaseFirst;
  let firstCreated;
  const firstCreatedPromise = new Promise((resolve) => {
    firstCreated = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const cleanup = createIdempotentCleanup(async () => {
    events.push(`cleanup:${resources.join(",")}`);
  });
  const shutdown = createShutdownCoordinator({
    cleanup,
    exit: (code) => events.push(`exit-${code}`),
    target,
  });
  const mainPromise = shutdown.startMain(async () => {
    await runStartupStep(shutdown, async () => {
      resources.push("first");
      firstCreated();
      await firstGate;
    });
    await runStartupStep(shutdown, async () => {
      resources.push("second");
    });
  });
  await firstCreatedPromise;
  target.emit("SIGINT");
  target.emit("SIGTERM");
  releaseFirst();
  await assert.rejects(mainPromise, /shutdown/i);
  await shutdown.completion;
  assert.deepEqual(resources, ["first"]);
  assert.deepEqual(events, ["cleanup:first", "exit-130"]);
  shutdown.remove();
});

test("managed process helpers guard exited Windows PIDs and use POSIX groups", () => {
  assert.equal(managedSpawnOptions("win32").detached, false);
  assert.equal(managedSpawnOptions("linux").detached, true);
  assert.equal(processTerminationAction("win32", { pid: 42, exitCode: 0, signalCode: null }), null);
  assert.deepEqual(
    processTerminationAction("win32", { pid: 42, exitCode: null, signalCode: null }),
    { command: "taskkill", args: ["/pid", "42", "/t", "/f"] },
  );
  assert.deepEqual(
    processTerminationAction("linux", { pid: 42, exitCode: null, signalCode: null }, "SIGTERM"),
    { signal: "SIGTERM", target: -42 },
  );
  assert.deepEqual(
    processTerminationAction("linux", {
      exitCode: 0,
      managedProcessGroup: 42,
      pid: 42,
      signalCode: null,
    }),
    { signal: "SIGTERM", target: -42 },
  );
});

test("browser timeout invokes shared cleanup before reporting timeout", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 42,
    signalCode: null,
  });
  const events = [];
  const timers = [];
  const pending = waitForManagedChild(child, {
    cleanup: async () => {
      await stopManagedProcessTree({
        child,
        platform: "win32",
        runWindows: async () => {
          events.push("taskkill-browser-tree");
          child.signalCode = "SIGTERM";
          return { status: 0 };
        },
        sendPosixSignal: () => events.push("unexpected-signal"),
        verifyWindowsLeaderMarker: async () => true,
        verifyWindowsMarkerAbsent: async () => events.push("verify-browser-marker"),
        waitForExit: async () => {
          events.push("wait-browser-tree");
          return true;
        },
      });
      events.push("compose-down");
    },
    label: "browser",
    setTimer: (callback) => {
      timers.push(callback);
      return 1;
    },
    clearTimer: () => events.push("clear-timer"),
    timeoutMs: 120_000,
  });
  await timers[0]();
  await assert.rejects(pending, (error) => {
    assert.equal(error.safeCategory, "timeout");
    return true;
  });
  assert.deepEqual(events, [
    "clear-timer",
    "taskkill-browser-tree",
    "wait-browser-tree",
    "verify-browser-marker",
    "compose-down",
  ]);
});

test("browser nonzero exit propagates status without invoking timeout cleanup", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    pid: 43,
    signalCode: null,
  });
  let cleanupCalls = 0;
  let timerCallback;
  const pending = waitForManagedChild(child, {
    cleanup: async () => {
      cleanupCalls += 1;
    },
    label: "browser",
    setTimer: (callback) => {
      timerCallback = callback;
      return 2;
    },
    clearTimer: () => undefined,
    timeoutMs: 120_000,
  });
  child.exitCode = 7;
  child.emit("exit", 7, null);
  await assert.rejects(pending, (error) => {
    assert.equal(error.safeCategory, "exit");
    assert.equal(error.exitCode, 7);
    return true;
  });
  assert.equal(cleanupCalls, 0);
  assert.equal(typeof timerCallback, "function");
});

test("managed child spawn errors reject with a fixed category", async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    managedSpawnError: null,
    pid: undefined,
    signalCode: null,
  });
  const pending = waitForManagedChild(child, {
    cleanup: async () => undefined,
    label: "browser",
    timeoutMs: 120_000,
  });
  child.managedSpawnError = true;
  child.emit("error", new Error("raw spawn error"));
  await assert.rejects(pending, (error) => {
    assert.equal(error.safeCategory, "spawn");
    assert.doesNotMatch(error.message, /raw spawn error/);
    return true;
  });
});

test("already-exited Windows child skips taskkill but still verifies marker absence", async () => {
  const calls = [];
  await stopManagedProcessTree({
    child: { exitCode: 0, pid: 44, signalCode: null },
    platform: "win32",
    runWindows: async () => calls.push("taskkill"),
    sendPosixSignal: () => calls.push("signal"),
    verifyWindowsLeaderMarker: async () => {
      calls.push("leader-check");
      return false;
    },
    verifyWindowsMarkerAbsent: async () => calls.push("verify"),
    waitForExit: async () => {
      calls.push("wait");
      return true;
    },
  });
  assert.deepEqual(calls, ["verify"]);
});

test("Windows managed tree cleanup uses taskkill and bounded wait", async () => {
  const child = { exitCode: null, pid: 45, signalCode: null };
  const calls = [];
  await stopManagedProcessTree({
    child,
    platform: "win32",
    runWindows: async (action) => {
      calls.push(action);
      child.exitCode = 1;
      return { status: 0 };
    },
    sendPosixSignal: () => calls.push("unexpected-signal"),
    verifyWindowsLeaderMarker: async () => {
      calls.push("verify-leader-marker");
      return true;
    },
    verifyWindowsMarkerAbsent: async () => calls.push("verify-marker"),
    waitForExit: async (_candidate, timeoutMs) => {
      calls.push({ timeoutMs });
      return true;
    },
  });
  assert.deepEqual(calls, [
    "verify-leader-marker",
    { command: "taskkill", args: ["/pid", "45", "/t", "/f"] },
    { timeoutMs: 5_000 },
    "verify-marker",
  ]);
});

test("exact Windows marker filtering rejects partial marker matches", () => {
  const marker = "agency-workload-smoke-0123456789abcdef0123456789abcdef-browser";
  assert.deepEqual(
    filterExactWindowsMarkerProcesses(
      [
        { CommandLine: `node tool.mjs --smoke-process-marker=${marker}`, ProcessId: 50 },
        { CommandLine: `chrome --agency-workload-smoke-marker=${marker}`, ProcessId: 51 },
        { CommandLine: `node --smoke-process-marker=${marker}-suffix`, ProcessId: 52 },
        { CommandLine: `node prefix--smoke-process-marker=${marker}`, ProcessId: 53 },
      ],
      marker,
    ).map((record) => record.processId),
    [50, 51],
  );
});

test("Windows marker cleanup revalidates and kills only an exact current PID", async () => {
  const marker = "agency-workload-smoke-0123456789abcdef0123456789abcdef-browser";
  const record = { commandLine: `node --smoke-process-marker=${marker}`, processId: 54 };
  const scans = [[record], [record], []];
  const kills = [];
  await terminateWindowsMarkerProcesses({
    listExactProcesses: async () => scans.shift() ?? [],
    marker,
    now: (() => {
      let time = 0;
      return () => (time += 10);
    })(),
    runTaskkill: async (action) => kills.push(action),
    sleep: async () => undefined,
    timeoutMs: 100,
  });
  assert.deepEqual(kills, [{ command: "taskkill", args: ["/pid", "54", "/t", "/f"] }]);
});

test("Windows marker cleanup does not kill a PID that changed before revalidation", async () => {
  const marker = "agency-workload-smoke-0123456789abcdef0123456789abcdef-browser";
  const scans = [
    [{ commandLine: `node --smoke-process-marker=${marker}`, processId: 55 }],
    [{ commandLine: `node --smoke-process-marker=${marker}`, processId: 56 }],
    [],
  ];
  const kills = [];
  await terminateWindowsMarkerProcesses({
    listExactProcesses: async () => scans.shift() ?? [],
    marker,
    now: (() => {
      let time = 0;
      return () => (time += 10);
    })(),
    runTaskkill: async (action) => kills.push(action),
    sleep: async () => undefined,
    timeoutMs: 100,
  });
  assert.deepEqual(kills, []);
});

test("Windows marker cleanup fails when exact residuals remain", async () => {
  const marker = "agency-workload-smoke-0123456789abcdef0123456789abcdef-browser";
  const record = { commandLine: `node --smoke-process-marker=${marker}`, processId: 57 };
  await assert.rejects(
    terminateWindowsMarkerProcesses({
      listExactProcesses: async () => [record],
      marker,
      now: (() => {
        let time = 0;
        return () => (time += 60);
      })(),
      runTaskkill: async () => ({ status: 0 }),
      sleep: async () => undefined,
      timeoutMs: 100,
    }),
    /remain/i,
  );
});

test("POSIX managed group cleanup escalates from TERM to KILL with bounded waits", async () => {
  const child = { exitCode: null, pid: 46, signalCode: null };
  const calls = [];
  let waits = 0;
  await stopManagedProcessTree({
    child,
    platform: "linux",
    runWindows: async () => calls.push("unexpected-taskkill"),
    sendPosixSignal: (action) => calls.push(action),
    waitForGroupAbsence: async (_processGroup, timeoutMs) => {
      calls.push({ timeoutMs });
      waits += 1;
      if (waits === 2) child.signalCode = "SIGKILL";
      return waits === 2;
    },
  });
  assert.deepEqual(calls, [
    { signal: "SIGTERM", target: -46 },
    { timeoutMs: 5_000 },
    { signal: "SIGKILL", target: -46 },
    { timeoutMs: 5_000 },
  ]);
});

test("POSIX cleanup targets a known group even after its leader exited", async () => {
  const child = {
    exitCode: 0,
    managedProcessGroup: 47,
    pid: 47,
    signalCode: null,
  };
  const signals = [];
  await stopManagedProcessTree({
    child,
    platform: "linux",
    runWindows: async () => ({ status: 1 }),
    sendPosixSignal: (action) => signals.push(action),
    waitForGroupAbsence: async () => true,
  });
  assert.deepEqual(signals, [{ signal: "SIGTERM", target: -47 }]);
});

test("exact startup readiness rejects redirects, wrong URLs, types, and health bodies", () => {
  const expected = {
    expectedContentType: "application/json",
    expectedUrl: "http://localhost:32102/healthz",
  };
  assert.doesNotThrow(() =>
    assertReadinessMetadata(
      {
        contentType: "application/json; charset=utf-8",
        finalUrl: expected.expectedUrl,
        status: 200,
      },
      expected,
    ),
  );
  assert.doesNotThrow(() => assertExactHealthBody({ status: "ok" }));
  assert.throws(
    () =>
      assertReadinessMetadata(
        { contentType: "application/json", finalUrl: expected.expectedUrl, status: 302 },
        expected,
      ),
    /status/i,
  );
  assert.throws(
    () =>
      assertReadinessMetadata(
        {
          contentType: "application/json",
          finalUrl: "http://localhost:32102/login",
          status: 200,
        },
        expected,
      ),
    /URL/i,
  );
  assert.throws(
    () =>
      assertReadinessMetadata(
        { contentType: "text/html", finalUrl: expected.expectedUrl, status: 200 },
        expected,
      ),
    /content type/i,
  );
  assert.throws(() => assertExactHealthBody({ status: "ok", extra: true }), /health body/i);
});

test("required schedule completion accepts only fresh 2xx core endpoints", () => {
  assert.deepEqual(requiredSchedulePaths, [
    "/api/v1/planning/settings",
    "/api/v1/people",
    "/api/v1/projects",
    "/api/v1/allocations",
    "/api/v1/schedule",
  ]);
  const state = createNetworkState();
  const baseline = completionSnapshot(state, requiredSchedulePaths);
  for (const path of requiredSchedulePaths) {
    recordApiResponse(state, { method: "GET", path, status: 200 });
  }
  recordApiResponse(state, { method: "GET", path: "/api/v1/teams", status: 200 });
  assert.doesNotThrow(() => assertNetworkHealthy(state));
  assert.doesNotThrow(() =>
    assertDestinationRequestsCompleted(state, requiredSchedulePaths, baseline),
  );
});

test("3xx API responses fail and never count as destination completion", () => {
  const state = createNetworkState();
  const baseline = completionSnapshot(state, requiredSchedulePaths);
  recordApiResponse(state, {
    method: "GET",
    path: "/api/v1/planning/settings",
    status: 302,
  });
  assert.throws(() => assertNetworkHealthy(state), /response/i);
  assert.throws(
    () => assertDestinationRequestsCompleted(state, requiredSchedulePaths, baseline),
    /destination/i,
  );
});

test("non-GET and non-200 API responses cannot satisfy destination counters", () => {
  for (const item of [
    { method: "POST", path: "/api/v1/schedule", status: 200 },
    { method: "GET", path: "/api/v1/schedule", status: 201 },
    { method: "GET", path: "/api/v1/schedule/", status: 200 },
  ]) {
    const state = createNetworkState();
    const baseline = completionSnapshot(state, ["/api/v1/schedule"]);
    recordApiResponse(state, item);
    assert.throws(
      () => assertDestinationRequestsCompleted(state, ["/api/v1/schedule"], baseline),
      /destination/i,
    );
  }
});

test("evicted response failures still fail the smoke", () => {
  const state = createNetworkState();
  recordApiResponse(state, { method: "GET", path: "/api/v1/failure", status: 500 }, 2);
  for (let index = 0; index < 5; index += 1) {
    appendBoundedNetworkEvidence(
      state.evidence,
      { method: "GET", path: `/api/v1/success-${index}`, status: 200 },
      2,
    );
  }
  assert.equal(
    state.evidence.some((item) => item.status === 500),
    false,
  );
  assert.throws(() => assertNetworkHealthy(state), /response/i);
});

test("any API request failure is fatal, including unrelated aborts", () => {
  const state = createNetworkState();
  recordApiTransportFailure(state);
  assert.throws(() => assertNetworkHealthy(state), /transport/i);
});

test("missing one core endpoint fails even when optional catalogs complete", () => {
  const state = createNetworkState();
  const baseline = completionSnapshot(state, requiredSchedulePaths);
  for (const path of requiredSchedulePaths.filter((path) => path !== "/api/v1/schedule")) {
    recordApiResponse(state, { method: "GET", path, status: 200 });
  }
  for (const path of ["/api/v1/teams", "/api/v1/delivery-roles", "/api/v1/tags"]) {
    recordApiResponse(state, { method: "GET", path, status: 200 });
  }
  assert.throws(
    () => assertDestinationRequestsCompleted(state, requiredSchedulePaths, baseline),
    /destination/i,
  );
});

test("sources prohibit persistent services and preserve sanitized evidence", async () => {
  const [runner, browser, disposable, compose, manifest] = await Promise.all([
    readFile(new URL("../run-browser-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../browser-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../lib/disposable-browser-smoke.mjs", import.meta.url), "utf8"),
    readFile(new URL("../../infra/compose.smoke.yml", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
  ]);
  const runtimeSources = `${runner}\n${browser}\n${disposable}`;
  assert.equal(
    JSON.parse(manifest).scripts["test:browser:smoke"],
    "node tools/run-browser-smoke.mjs",
  );
  assert.doesNotMatch(runtimeSources, /--env-file|loadEnvFile|dotenv|readFile[^\n]*\.env/);
  assert.doesNotMatch(runtimeSources, /persistentPortsFromEnvironment/);
  assert.doesNotMatch(
    runtimeSources,
    /project-postgres|persistentState|Fingerprint|BACKUP_DATABASE_URL/,
  );
  assert.doesNotMatch(runtimeSources, /127\.0\.0\.1:(?:5434|9999|8025)/);
  assert.doesNotMatch(runtimeSources, /isExpectedApiTransitionCancellation|ERR_ABORTED/);
  assert.doesNotMatch(runtimeSources, /method:\s*["']DELETE["']/);
  assert.doesNotMatch(
    runtimeSources,
    /docker\s+(?:system|volume|container|network)\s+prune|rm\s+-rf/i,
  );
  assert.doesNotMatch(compose, /^(?:name|container_name):/m);
  assert.match(
    compose,
    /postgres@sha256:16bc17c64a573ef34162af9298258d1aec548232985b33ed7b1eac33ba35c229/,
  );
  assert.match(compose, /postgres-data:/);
  assert.match(compose, /internal:\s*true/);
  assert.match(compose, /host-access:/);
  assert.match(runner, /createShutdownCoordinator/);
  assert.match(runner, /runStartupStep/);
  assert.match(runner, /shutdown\.signal/);
  assert.match(runner, /context\.children/);
  assert.match(runner, /finalCleanupRescan/);
  assert.match(runner, /dockerContextInspectInvocation/);
  assert.match(runner, /assertLocalDockerEndpoint/);
  assert.match(runner, /redirect: "error"/);
  assert.match(runner, /AbortSignal\.timeout/);
  assert.match(runner, /timeout: 10_000/);
  assert.match(runner, /cleanupOnce/);
  assert.match(runner, /registerChild\([\s\S]*"browser"/);
  assert.match(runner, /waitForManagedChild\(browserChild/);
  assert.doesNotMatch(runner, /runCommand\(process\.execPath, \[browserFile\]/);
  assert.match(runner, /liveChildren\(context\)/);
  assert.match(runner, /process\.exitCode = context\.executionExitCode/);
  assert.match(runner, /const shutdown = createShutdownCoordinator[\s\S]*shutdown\.startMain/);
  assert.match(runner, /if \(shutdown\.requested\)[\s\S]*await shutdown\.completion/);
  assert.match(browser, /if \("value" in element\) element\.value = ""/);
  assert.match(browser, /if \(text && !allowed\.has\(text\)\) node\.textContent = "\[redacted\]"/);
  assert.doesNotMatch(browser, /allTextContents\(\)|error\.message|response\.text\(\).*summary/);
});

test("obsolete shared-state fixture helper remains absent", async () => {
  await assert.rejects(
    access(new URL("../lib/browser-smoke-fixture.mjs", import.meta.url)),
    /ENOENT/,
  );
});
