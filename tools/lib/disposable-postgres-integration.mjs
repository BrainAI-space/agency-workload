import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  assertDockerEndpointOverridesSafe,
  assertLocalDockerEndpoint,
  dockerContextInspectInvocation,
  dockerResourceListInvocation,
} from "./browser-smoke-docker.mjs";
import {
  createIdempotentCleanup,
  createShutdownCoordinator,
  managedSpawnOptions,
  runStartupStep,
  stopManagedProcessTree,
  waitForManagedChild,
} from "./browser-smoke-process.mjs";
import { listWindowsMarkerProcesses } from "./browser-smoke-windows.mjs";
import {
  AUTH_PORT_MAX,
  AUTH_PORT_MIN,
  allocateDistinctAuthPorts,
  createOperationDeadline,
  probeAuthPort,
  runCommandWithinDeadline,
} from "./disposable-auth-integration.mjs";
import {
  assertSmokeIdentity,
  buildInitializeClusterSql,
  buildInitializeDatabaseSql,
  createSmokeIdentity,
  disposablePsqlInvocation,
} from "./disposable-browser-smoke.mjs";
import {
  buildPostgresIntegrationEnvironment,
  POSTGRES_INTEGRATION_SUITES,
} from "./postgres-integration-boundary.mjs";

export const POSTGRES_INTEGRATION_MAIN_BUDGET_MS = 240_000;
export const POSTGRES_INTEGRATION_CLEANUP_BUDGET_MS = 30_000;

const composeFile = "infra/compose.smoke.yml";
const persistentPorts = new Set([1025, 3100, 4100, 5432, 5434, 8025, 9999]);
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

function setupFor(suite) {
  const setup = POSTGRES_INTEGRATION_SUITES[suite];
  if (!setup) throw new Error("Disposable PostgreSQL integration suite is invalid");
  return setup;
}

function systemEnvironment(environment) {
  const result = {};
  for (const key of systemEnvironmentKeys) {
    if (typeof environment[key] === "string" && environment[key]) result[key] = environment[key];
  }
  return result;
}

function dockerEnvironment(environment) {
  const result = systemEnvironment(environment);
  result.COMPOSE_DISABLE_ENV_FILE = "true";
  return result;
}

function randomSecret() {
  return randomBytes(32).toString("base64url");
}

function databaseUrl(username, password, port, databaseName) {
  const url = new URL(`postgresql://${username}@127.0.0.1:${port}/${databaseName}`);
  url.password = password;
  return url.toString();
}

function createPostgresConfiguration(identity, postgresPort) {
  const migratorPassword = randomSecret();
  const runtimePassword = randomSecret();
  return Object.freeze({
    authPassword: randomSecret(),
    backupPassword: randomSecret(),
    migrationDatabaseUrl: databaseUrl(
      "agency_workload_migrator",
      migratorPassword,
      postgresPort,
      identity.databaseName,
    ),
    migratorPassword,
    ports: Object.freeze({ postgres: postgresPort }),
    postgresPassword: randomSecret(),
    runtimeDatabaseUrl: databaseUrl(
      "agency_workload_runtime",
      runtimePassword,
      postgresPort,
      identity.databaseName,
    ),
    runtimePassword,
  });
}

function buildHarnessEnvironments(configuration, identity, inheritedEnvironment, runToken, suite) {
  const system = systemEnvironment(inheritedEnvironment);
  const docker = dockerEnvironment(inheritedEnvironment);
  const inactiveServicePlaceholders = {
    GOTRUE_JWT_SECRET: "unused-by-postgres-integration",
    SMOKE_APP_ORIGIN: "http://localhost:1",
    SMOKE_DATABASE_NAME: identity.databaseName,
    SMOKE_GOTRUE_DATABASE_URL: `postgresql://unused:unused@postgres:5432/${identity.databaseName}`,
    SMOKE_GOTRUE_ORIGIN: "http://127.0.0.1:1",
    SMOKE_GOTRUE_PORT: "1",
    SMOKE_MAILPIT_PORT: "2",
    SMOKE_SMTP_PORT: "3",
  };
  return Object.freeze({
    compose: Object.freeze({
      ...docker,
      ...inactiveServicePlaceholders,
      SMOKE_POSTGRES_PASSWORD: configuration.postgresPassword,
      SMOKE_POSTGRES_PORT: String(configuration.ports.postgres),
    }),
    docker: Object.freeze({ ...docker }),
    integration: buildPostgresIntegrationEnvironment({
      configuration,
      identity,
      inheritedEnvironment,
      runToken,
      suite,
    }),
    migration: Object.freeze({
      ...system,
      MIGRATION_DATABASE_URL: configuration.migrationDatabaseUrl,
    }),
    process: Object.freeze({ ...system }),
  });
}

export function createPostgresIntegrationIdentity(runToken, suite) {
  setupFor(suite);
  if (!/^[a-f0-9]{64}$/.test(runToken)) {
    throw new Error("Disposable PostgreSQL integration run token is invalid");
  }
  const identity = createSmokeIdentity(runToken.slice(0, 32));
  return Object.freeze({
    ...identity,
    marker: `${identity.composeProject}-${suite}`,
    runToken,
    suite,
  });
}

export function postgresComposeInvocation(identity, ...args) {
  assertSmokeIdentity(identity);
  return {
    command: "docker",
    args: ["compose", "--project-name", identity.composeProject, "-f", composeFile, ...args],
  };
}

export function assertPostgresDockerOverridesSafe(environment) {
  assertDockerEndpointOverridesSafe(environment);
  if (typeof environment.DOCKER_CONFIG === "string" && environment.DOCKER_CONFIG) {
    throw new Error("Disposable PostgreSQL integration refuses the DOCKER_CONFIG override");
  }
}

function commandRunner(root, deadline) {
  return (
    command,
    args,
    { environment, input, timeout = POSTGRES_INTEGRATION_MAIN_BUDGET_MS } = {},
  ) => {
    if (!environment) {
      throw new Error("Disposable PostgreSQL integration subprocess environment is required");
    }
    return runCommandWithinDeadline({
      args,
      command,
      deadline,
      environment,
      input,
      root,
      stepTimeoutMs: timeout,
    });
  };
}

async function allocatePostgresPort(deadline) {
  const ports = await allocateDistinctAuthPorts({
    candidateSource: () => randomInt(AUTH_PORT_MIN, AUTH_PORT_MAX + 1),
    deadline,
    keys: ["postgres"],
    persistentPorts,
    probe: probeAuthPort,
  });
  const port = ports.postgres;
  if (
    !Number.isSafeInteger(port) ||
    port < AUTH_PORT_MIN ||
    port > AUTH_PORT_MAX ||
    persistentPorts.has(port)
  ) {
    throw new Error("Disposable PostgreSQL integration port is unsafe");
  }
  deadline.throwIfExpired();
  return port;
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function assertPortClosed(port) {
  if (await portOpen(port)) {
    throw new Error("Disposable PostgreSQL integration isolated port remained open");
  }
}

async function waitForPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portOpen(port))) return;
    await delay(100);
  }
  throw new Error("Disposable PostgreSQL integration port did not close");
}

function sendPosixSignal(action) {
  try {
    process.kill(action.target, action.signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function groupExists(processGroup) {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForGroupAbsence(processGroup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupExists(processGroup)) return true;
    await delay(50);
  }
  return !groupExists(processGroup);
}

async function waitForExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await delay(50);
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildBootstrapOwnerFixtureSql(identity, ids) {
  if (
    !/^[0-9a-f-]{36}$/.test(ids.organizationId) ||
    !/^[0-9a-f-]{36}$/.test(ids.userId) ||
    !/^[0-9a-f-]{36}$/.test(ids.gotrueUserId)
  ) {
    throw new Error("Disposable PostgreSQL owner fixture identity is invalid");
  }
  return `
\\set ON_ERROR_STOP on
INSERT INTO app.organizations (id, slug, name)
VALUES (${sqlLiteral(ids.organizationId)}, 'agency-workload', 'Agency Workload');
INSERT INTO app.users (id, gotrue_user_id, email)
VALUES (${sqlLiteral(ids.userId)}, ${sqlLiteral(ids.gotrueUserId)}, ${sqlLiteral(identity.bootstrapEmail)});
INSERT INTO app.memberships (organization_id, user_id, role)
VALUES (${sqlLiteral(ids.organizationId)}, ${sqlLiteral(ids.userId)}, 'owner');
INSERT INTO app.audit_events
  (id, organization_id, actor_user_id, action, target_type, target_id)
VALUES (${sqlLiteral(randomUUID())}, ${sqlLiteral(ids.organizationId)}, ${sqlLiteral(ids.userId)},
        'owner.bootstrapped', 'user', ${sqlLiteral(ids.userId)});
`;
}

export function buildVerifyBootstrapOwnerFixtureSql(identity) {
  return `
\\set ON_ERROR_STOP on
DO $aw_bootstrap_verify$
BEGIN
  IF (SELECT count(*) FROM app.memberships membership
      JOIN app.users app_user ON app_user.id = membership.user_id
      WHERE membership.role = 'owner' AND membership.active
        AND app_user.email = ${sqlLiteral(identity.bootstrapEmail)}) <> 1 THEN
    RAISE EXCEPTION 'disposable owner fixture verification failed';
  END IF;
END
$aw_bootstrap_verify$;
`;
}

function resourceIdsWith(runner, environment, composeProject, kind) {
  const invocation = dockerResourceListInvocation(kind, composeProject);
  return runner(invocation.command, invocation.args, { environment, timeout: 10_000 })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertResourcesAbsent(runner, environment, identity) {
  if (
    ["container", "network", "volume"].some(
      (kind) => resourceIdsWith(runner, environment, identity.composeProject, kind).length > 0,
    )
  ) {
    throw new Error("Disposable PostgreSQL integration Compose resources remain");
  }
}

function assertComposeResources(runner, compose, environment, identity) {
  const services = compose(runner, "ps", "--services", "--status", "running")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (services.length !== 1 || services[0] !== "postgres") {
    throw new Error("Disposable PostgreSQL integration started unexpected services");
  }
  const containerLabels = runner(
    "docker",
    [
      "inspect",
      "--format",
      '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}',
      identity.containers.postgres,
    ],
    { environment, timeout: 10_000 },
  ).trim();
  const networkProject = (name) =>
    runner(
      "docker",
      ["network", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}', name],
      { environment, timeout: 10_000 },
    ).trim();
  const volumeProject = runner(
    "docker",
    [
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "com.docker.compose.project"}}',
      identity.volumeName,
    ],
    { environment, timeout: 10_000 },
  ).trim();
  if (
    containerLabels !== `${identity.composeProject}|postgres` ||
    networkProject(identity.networkName) !== identity.composeProject ||
    networkProject(identity.hostNetworkName) !== identity.composeProject ||
    volumeProject !== identity.composeProject
  ) {
    throw new Error("Disposable PostgreSQL integration resource identity is unexpected");
  }
}

export async function runDisposablePostgresIntegration({ root, suite, testFile }) {
  const mainDeadline = createOperationDeadline({ budgetMs: POSTGRES_INTEGRATION_MAIN_BUDGET_MS });
  const setup = setupFor(suite);
  if (testFile !== setup.testFile) {
    throw new Error("Disposable PostgreSQL integration test target mismatch");
  }
  const run = commandRunner(root, mainDeadline);
  const childFile = join(root, "tools", "run-postgres-integration-child.mjs");
  const runToken = randomBytes(32).toString("hex");
  const identity = createPostgresIntegrationIdentity(runToken, suite);
  const context = {
    child: null,
    composeStarted: false,
    configuration: null,
    dockerValidated: false,
    environments: null,
    port: null,
    stage: "startup",
  };
  const composeWith = (runner, ...args) => {
    const invocation = postgresComposeInvocation(identity, ...args);
    return runner(invocation.command, invocation.args, {
      environment: context.environments.compose,
      timeout: 180_000,
    });
  };
  const psql = (target, sql) => {
    const invocation = disposablePsqlInvocation(identity, target, composeFile);
    return run(invocation.command, invocation.args, {
      environment: context.environments.compose,
      input: sql,
      timeout: 30_000,
    });
  };

  const cleanupOnce = createIdempotentCleanup(async () => {
    const cleanupDeadline = createOperationDeadline({
      budgetMs: POSTGRES_INTEGRATION_CLEANUP_BUDGET_MS,
    });
    const cleanupRun = commandRunner(root, cleanupDeadline);
    const failures = [];
    if (context.child) {
      const processTimeout = cleanupDeadline.timeoutFor(10_000);
      await stopManagedProcessTree({
        child: context.child,
        listWindowsMarkerProcesses: async () =>
          listWindowsMarkerProcesses(
            identity.marker,
            context.environments.process,
            spawnSync,
            cleanupDeadline.timeoutFor(10_000),
          ),
        marker: identity.marker,
        platform: process.platform,
        runWindows: async (action) =>
          runCommandWithinDeadline({
            args: action.args,
            command: action.command,
            deadline: cleanupDeadline,
            environment: context.environments.process,
            execute: spawnSync,
            root,
            stepTimeoutMs: processTimeout,
          }),
        sendPosixSignal,
        terminateTimeoutMs: processTimeout,
        killTimeoutMs: processTimeout,
        waitForExit,
        waitForGroupAbsence,
      }).catch(() => failures.push("process"));
    }
    if (context.dockerValidated && context.composeStarted) {
      try {
        composeWith(cleanupRun, "down", "-v", "--remove-orphans");
        context.composeStarted = false;
      } catch {
        failures.push("compose-down");
      }
    }
    try {
      if (process.platform === "win32" && context.environments) {
        if (
          listWindowsMarkerProcesses(
            identity.marker,
            context.environments.process,
            spawnSync,
            cleanupDeadline.timeoutFor(10_000),
          ).length > 0
        ) {
          throw new Error("Disposable PostgreSQL integration marker process remains");
        }
      } else if (context.child?.managedProcessGroup) {
        if (
          !(await waitForGroupAbsence(
            context.child.managedProcessGroup,
            cleanupDeadline.timeoutFor(500),
          ))
        ) {
          throw new Error("Disposable PostgreSQL integration process group remains");
        }
      }
      if (context.dockerValidated) {
        assertResourcesAbsent(cleanupRun, context.environments.docker, identity);
      }
      if (context.port) {
        await waitForPortClosed(context.port, cleanupDeadline.timeoutFor(15_000));
        await assertPortClosed(context.port);
      }
      cleanupDeadline.throwIfExpired();
    } catch {
      failures.push("final-rescan");
    }
    if (failures.length > 0) {
      throw new Error("Disposable PostgreSQL integration cleanup failed");
    }
  });
  const shutdown = createShutdownCoordinator({
    cleanup: cleanupOnce,
    exit: (code) => process.exit(code),
  });

  let failure = null;
  const mainStep = (action) =>
    runStartupStep(shutdown, async (signal) => {
      mainDeadline.throwIfExpired();
      const result = await action(signal, mainDeadline);
      mainDeadline.throwIfExpired();
      return result;
    });
  const main = shutdown.startMain(async () => {
    assertPostgresDockerOverridesSafe(process.env);
    context.stage = "port-allocation";
    await mainStep(async () => {
      context.port = await allocatePostgresPort(mainDeadline);
    });
    context.stage = "configuration";
    await mainStep(async () => {
      context.configuration = createPostgresConfiguration(identity, context.port);
      context.environments = buildHarnessEnvironments(
        context.configuration,
        identity,
        process.env,
        runToken,
        suite,
      );
    });
    context.stage = "docker-target";
    await mainStep(async () => {
      const invocation = dockerContextInspectInvocation();
      const endpoint = run(invocation.command, invocation.args, {
        environment: context.environments.docker,
        timeout: 10_000,
      }).trim();
      assertLocalDockerEndpoint(endpoint, process.platform);
      context.dockerValidated = true;
    });
    context.stage = "compose-foundation";
    await mainStep(async () => {
      await assertPortClosed(context.port);
      assertResourcesAbsent(run, context.environments.docker, identity);
      context.composeStarted = true;
      composeWith(run, "up", "-d", "--wait", "--wait-timeout", "120", "postgres");
      assertComposeResources(run, composeWith, context.environments.docker, identity);
    });
    context.stage = "database-initialization";
    await mainStep(async () => {
      psql("postgres", buildInitializeClusterSql(context.configuration, identity));
      psql("application", buildInitializeDatabaseSql());
    });
    if (setup.migrate) {
      context.stage = "migration";
      await mainStep(async () => {
        run(process.execPath, ["--import", "tsx", join(root, "packages", "db", "src", "cli.ts")], {
          environment: context.environments.migration,
          timeout: 60_000,
        });
      });
    }
    if (setup.bootstrapOwner) {
      context.stage = "owner-fixture";
      await mainStep(async () => {
        const ids = {
          gotrueUserId: randomUUID(),
          organizationId: randomUUID(),
          userId: randomUUID(),
        };
        psql("application", buildBootstrapOwnerFixtureSql(identity, ids));
        psql("application", buildVerifyBootstrapOwnerFixtureSql(identity));
      });
    }
    context.stage = "test-startup";
    const child = await mainStep(async () => {
      const spawned = spawn(
        process.execPath,
        [
          childFile,
          suite,
          testFile,
          ...setup.vitestArgs,
          `--smoke-process-marker=${identity.marker}`,
        ],
        {
          cwd: root,
          env: context.environments.integration,
          stdio: "inherit",
          windowsHide: true,
          ...managedSpawnOptions(process.platform),
        },
      );
      spawned.managedProcessGroup = process.platform === "win32" ? null : spawned.pid;
      spawned.managedProcessMarker = identity.marker;
      context.child = spawned;
      return spawned;
    });
    context.stage = "test-run";
    await waitForManagedChild(child, {
      cleanup: cleanupOnce,
      label: `${suite}-integration`,
      signal: shutdown.signal,
      timeoutMs: mainDeadline.timeoutFor(POSTGRES_INTEGRATION_MAIN_BUDGET_MS),
    });
    mainDeadline.throwIfExpired();
  });

  try {
    await main;
  } catch (error) {
    failure = error;
  }
  if (shutdown.requested) await shutdown.completion;
  else {
    await cleanupOnce();
    shutdown.remove();
  }
  if (failure) {
    const category = failure?.safeCategory ?? "operation";
    throw new Error(
      `Disposable PostgreSQL integration failed (${suite}/${context.stage}/${category})`,
    );
  }
  console.log(`Disposable PostgreSQL ${suite} integration passed and removed its resources.`);
}
