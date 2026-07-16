import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import { connect, createServer } from "node:net";
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
  assertDisposablePorts,
  buildAuthIntegrationEnvironment,
  buildChildEnvironments,
  buildInitializeClusterSql,
  buildInitializeDatabaseSql,
  createSmokeConfiguration,
  createSmokeIdentity,
  disposablePsqlInvocation,
  persistentPortExclusions,
} from "./disposable-browser-smoke.mjs";

export const AUTH_INTEGRATION_MAIN_BUDGET_MS = 180_000;
export const AUTH_INTEGRATION_CLEANUP_BUDGET_MS = 30_000;
export const AUTH_PORT_MIN = 49_152;
export const AUTH_PORT_MAX = 60_999;
const persistentAuthPorts = new Set([1025, 5434, 8025, 9999]);

function timeoutError() {
  const error = new Error("Disposable auth integration main deadline exceeded");
  error.safeCategory = "timeout";
  return error;
}

const retryableBindErrors = new Set(["EACCES", "EADDRINUSE", "EADDRNOTAVAIL"]);

export function createOperationDeadline({ budgetMs, now = () => performance.now() }) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1)
    throw new Error("Operation budget is invalid");
  const startedAt = now();
  const deadlineAt = startedAt + budgetMs;
  return Object.freeze({
    deadlineAt,
    now,
    remaining() {
      return Math.max(0, Math.floor(deadlineAt - now()));
    },
    throwIfExpired() {
      if (now() >= deadlineAt) throw timeoutError();
    },
    timeoutFor(stepTimeoutMs) {
      this.throwIfExpired();
      const remaining = this.remaining();
      if (remaining < 1) throw timeoutError();
      return Math.min(stepTimeoutMs, remaining);
    },
  });
}

export function runCommandWithinDeadline({
  args,
  command,
  deadline,
  environment,
  execute = spawnSync,
  input,
  root,
  stepTimeoutMs,
}) {
  const timeout = deadline.timeoutFor(stepTimeoutMs);
  const result = execute(command, args, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 2 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });
  deadline.throwIfExpired();
  if (result.error || result.status !== 0) {
    if (result.error?.code === "ETIMEDOUT") throw timeoutError();
    const error = new Error("Auth integration subprocess failed without exposing output");
    error.safeCategory = safeCategory(result);
    throw error;
  }
  return result.stdout ?? "";
}

export async function runBudgetedStartupSequence({ cleanup, deadline, steps }) {
  try {
    for (const step of steps) {
      deadline.throwIfExpired();
      await step();
      deadline.throwIfExpired();
    }
  } catch (error) {
    await cleanup();
    throw error?.safeCategory === "timeout" ? error : error;
  }
}

export function createAuthRunIdentity(runToken) {
  if (!/^[a-f0-9]{64}$/.test(runToken)) throw new Error("Auth integration run token is invalid");
  const suffix = runToken.slice(0, 32);
  const identity = createSmokeIdentity(suffix);
  return Object.freeze({
    ...identity,
    marker: identity.processMarkers.auth,
    runToken,
  });
}

export function validateAuthPorts(ports) {
  const values = Object.values(ports);
  if (
    values.length < 4 ||
    values.some(
      (port) =>
        !Number.isSafeInteger(port) ||
        port < AUTH_PORT_MIN ||
        port > AUTH_PORT_MAX ||
        persistentAuthPorts.has(port),
    )
  ) {
    throw new Error("Auth integration ports must use the dedicated high ephemeral range");
  }
  if (new Set(values).size !== values.length) {
    throw new Error("Auth integration ports must be mutually distinct");
  }
}

function safeCategory(result) {
  const text = `${result.error?.code ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (/authentication/.test(text)) return "authentication";
  if (/connection refused|could not connect|econnrefused/.test(text)) return "connection";
  if (/permission denied/.test(text)) return "permission";
  if (/cannot find|not found|does not exist/.test(text)) return "missing-object";
  return "exit";
}

function commandRunner(root, deadline) {
  return (
    command,
    args,
    { environment, input, timeout = AUTH_INTEGRATION_MAIN_BUDGET_MS } = {},
  ) => {
    if (!environment) throw new Error("Auth integration subprocess environment is required");
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

export function probeAuthPort(
  port,
  deadline,
  {
    clearTimer = clearTimeout,
    createServer: createProbeServer = createServer,
    setTimer = setTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    deadline.throwIfExpired();
    const server = createProbeServer();
    server.unref();
    let settled = false;
    let timer;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      server.removeAllListeners();
      const complete = () => (error ? reject(error) : resolve(true));
      try {
        server.close(complete);
      } catch {
        complete();
      }
    };
    server.once("error", (error) => finish(error));
    server.once("listening", () => finish(null));
    timer = setTimer(() => finish(timeoutError()), deadline.timeoutFor(2_000));
    try {
      server.listen(port, "127.0.0.1");
    } catch (error) {
      finish(error);
    }
  });
}

export async function allocateDistinctAuthPorts({
  attemptsPerPort = 32,
  candidateSource,
  deadline,
  keys,
  persistentPorts,
  probe,
}) {
  const ports = {};
  const used = new Set(persistentPorts);
  for (const key of keys) {
    let selected;
    for (let attempt = 0; attempt < attemptsPerPort; attempt += 1) {
      deadline.throwIfExpired();
      const candidate = candidateSource();
      if (
        !Number.isSafeInteger(candidate) ||
        candidate < AUTH_PORT_MIN ||
        candidate > AUTH_PORT_MAX ||
        persistentAuthPorts.has(candidate) ||
        used.has(candidate)
      ) {
        continue;
      }
      try {
        if (await probe(candidate, deadline)) {
          selected = candidate;
          break;
        }
      } catch (error) {
        if (error?.safeCategory === "timeout") throw error;
        if (retryableBindErrors.has(error?.code)) continue;
        throw new Error("Auth integration port probe failed");
      }
    }
    if (!Number.isSafeInteger(selected)) {
      throw new Error("Auth integration could not allocate isolated ports");
    }
    ports[key] = selected;
    used.add(selected);
  }
  return ports;
}

async function allocatePorts(persistentPorts, deadline) {
  const ports = await allocateDistinctAuthPorts({
    candidateSource: () => randomInt(AUTH_PORT_MIN, AUTH_PORT_MAX + 1),
    deadline,
    keys: ["postgres", "web", "api", "gotrue", "smtp", "mailpit"],
    persistentPorts,
    probe: probeAuthPort,
  });
  assertDisposablePorts(ports, persistentPorts);
  validateAuthPorts(ports);
  deadline.throwIfExpired();
  return Object.freeze(ports);
}

function composeArgs(composeFile, identity, ...args) {
  return ["compose", "--project-name", identity.composeProject, "-f", composeFile, ...args];
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

async function assertPortsClosed(ports) {
  if ((await Promise.all(Object.values(ports).map(portOpen))).some(Boolean)) {
    throw new Error("Auth integration isolated port remained open");
  }
}

async function waitForPortsClosed(ports, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(Object.values(ports).map(portOpen))).every((open) => !open)) return;
    await delay(100);
  }
  throw new Error("Auth integration ports did not close");
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

export async function runDisposableAuthIntegration({ root, testFile }) {
  const mainDeadline = createOperationDeadline({ budgetMs: AUTH_INTEGRATION_MAIN_BUDGET_MS });
  const run = commandRunner(root, mainDeadline);
  const composeFile = join(root, "infra", "compose.smoke.yml");
  const childFile = join(root, "tools", "run-auth-integration-child.mjs");
  const runToken = randomBytes(32).toString("hex");
  const identity = createAuthRunIdentity(runToken);
  const context = {
    child: null,
    composeStarted: false,
    dockerValidated: false,
    environments: null,
    ports: null,
    stage: "startup",
  };

  const composeWith = (runner, ...args) =>
    runner("docker", composeArgs(composeFile, identity, ...args), {
      environment: context.environments.compose,
      timeout: 180_000,
    });
  const resourceIdsWith = (runner, kind) => {
    const invocation = dockerResourceListInvocation(kind, identity.composeProject);
    return runner(invocation.command, invocation.args, {
      environment: context.environments.docker,
      timeout: 10_000,
    })
      .split(/\r?\n/)
      .filter(Boolean);
  };
  const assertResourcesAbsentWith = (runner) => {
    if (
      ["container", "network", "volume"].some((kind) => resourceIdsWith(runner, kind).length > 0)
    ) {
      throw new Error("Auth integration Compose resources remain");
    }
  };
  const psql = (target, sql) => {
    const invocation = disposablePsqlInvocation(identity, target, composeFile);
    return run(invocation.command, invocation.args, {
      environment: context.environments.compose,
      input: sql,
    });
  };
  const cleanupOnce = createIdempotentCleanup(async () => {
    const cleanupDeadline = createOperationDeadline({
      budgetMs: AUTH_INTEGRATION_CLEANUP_BUDGET_MS,
    });
    const cleanupRun = commandRunner(root, cleanupDeadline);
    const failures = [];
    if (context.child) {
      const processTimeout = cleanupDeadline.timeoutFor(10_000);
      await stopManagedProcessTree({
        child: context.child,
        listWindowsMarkerProcesses: async () =>
          listWindowsMarkerProcesses(
            identity.processMarkers.auth,
            context.environments.process,
            spawnSync,
            cleanupDeadline.timeoutFor(10_000),
          ),
        marker: identity.processMarkers.auth,
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
            identity.processMarkers.auth,
            context.environments.process,
            spawnSync,
            cleanupDeadline.timeoutFor(10_000),
          ).length > 0
        ) {
          throw new Error("Auth integration marker process remains");
        }
      } else if (context.child?.managedProcessGroup) {
        if (
          !(await waitForGroupAbsence(
            context.child.managedProcessGroup,
            cleanupDeadline.timeoutFor(500),
          ))
        ) {
          throw new Error("Auth integration process group remains");
        }
      }
      if (context.dockerValidated) assertResourcesAbsentWith(cleanupRun);
      if (context.ports) {
        await waitForPortsClosed(context.ports, cleanupDeadline.timeoutFor(15_000));
        await assertPortsClosed(context.ports);
      }
      cleanupDeadline.throwIfExpired();
    } catch {
      failures.push("final-rescan");
    }
    if (failures.length > 0) throw new Error("Auth integration cleanup failed");
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
    assertDockerEndpointOverridesSafe(process.env);
    context.stage = "port-allocation";
    await mainStep(async () => {
      context.ports = await allocatePorts(persistentPortExclusions(), mainDeadline);
    });
    let configuration;
    context.stage = "configuration";
    context.stage = "docker-target";
    await mainStep(async () => {
      configuration = createSmokeConfiguration(identity, context.ports);
      const shared = buildChildEnvironments(configuration, process.env);
      context.environments = {
        ...shared,
        auth: buildAuthIntegrationEnvironment(configuration, process.env, { runToken }),
      };
    });
    context.stage = "preflight";
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
      await assertPortsClosed(context.ports);
      assertResourcesAbsentWith(run);
    });
    context.stage = "database-initialization";
    await mainStep(async () => {
      context.composeStarted = true;
      composeWith(run, "up", "-d", "--wait", "--wait-timeout", "120", "postgres", "mailpit");
    });
    context.stage = "migration";
    await mainStep(async () => {
      psql("postgres", buildInitializeClusterSql(configuration, identity));
      psql("application", buildInitializeDatabaseSql());
    });
    context.stage = "gotrue-startup";
    await mainStep(async () => {
      run(process.execPath, ["--import", "tsx", join(root, "packages", "db", "src", "cli.ts")], {
        environment: context.environments.migration,
      });
    });
    context.stage = "owner-bootstrap";
    await mainStep(async () => {
      composeWith(run, "up", "-d", "--wait", "--wait-timeout", "120", "gotrue");
    });
    await mainStep(async () => {
      run(
        process.execPath,
        ["--import", "tsx", join(root, "apps", "api", "src", "bootstrap-owner.ts")],
        { environment: context.environments.bootstrap },
      );
    });
    context.stage = "test-startup";
    const child = await mainStep(async () => {
      const spawned = spawn(
        process.execPath,
        [childFile, testFile, `--smoke-process-marker=${identity.processMarkers.auth}`],
        {
          cwd: root,
          env: context.environments.auth,
          stdio: "inherit",
          windowsHide: true,
          ...managedSpawnOptions(process.platform),
        },
      );
      spawned.managedProcessGroup = process.platform === "win32" ? null : spawned.pid;
      spawned.managedProcessMarker = identity.processMarkers.auth;
      context.child = spawned;
      return spawned;
    });
    context.stage = "test-run";
    await waitForManagedChild(child, {
      cleanup: cleanupOnce,
      label: "auth-integration",
      signal: shutdown.signal,
      timeoutMs: mainDeadline.timeoutFor(AUTH_INTEGRATION_MAIN_BUDGET_MS),
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
    const message = failure?.safeCategory ?? "operation";
    throw new Error(`Disposable auth integration failed (${context.stage}/${message})`);
  }
  console.log("Disposable auth integration passed and removed its isolated resources.");
}
