import { spawn, spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import {
  assertDockerEndpointOverridesSafe,
  assertLocalDockerEndpoint,
  dockerContextInspectInvocation,
  dockerResourceListInvocation,
} from "./lib/browser-smoke-docker.mjs";
import {
  createIdempotentCleanup,
  createShutdownCoordinator,
  filterExactWindowsMarkerProcesses,
  managedSpawnOptions,
  runStartupStep,
  stopManagedProcessTree,
  waitForManagedChild,
} from "./lib/browser-smoke-process.mjs";
import { assertExactHealthBody, assertReadinessMetadata } from "./lib/browser-smoke-readiness.mjs";
import { listWindowsMarkerProcesses } from "./lib/browser-smoke-windows.mjs";
import {
  assertDisposablePorts,
  buildChildEnvironments,
  buildInitializeClusterSql,
  buildInitializeDatabaseSql,
  createSmokeConfiguration,
  createSmokeIdentity,
  disposablePsqlInvocation,
  generateSmokeSuffix,
  persistentPortExclusions,
} from "./lib/disposable-browser-smoke.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const composeFile = join(root, "infra", "compose.smoke.yml");
const browserFile = join(root, "tools", "browser-smoke.mjs");
const webRoot = join(root, "apps", "web");
const viteCli = join(root, "node_modules", "vite", "bin", "vite.js");
const nodeWithTsx = ["--import", "tsx"];

function safeSubprocessCategory(result) {
  const text = `${result.error?.code ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (/password authentication|authentication failed/.test(text)) return "authentication";
  if (/econnrefused|connection refused|could not connect/.test(text)) return "connection";
  if (/permission denied/.test(text)) return "permission";
  if (/must be (?:member|owner)|ownership/.test(text)) return "ownership";
  if (/does not exist|unknown flag|not found/.test(text)) return "missing-object";
  if (/err_module_not_found|cannot find (?:module|package)/.test(text)) return "module";
  if (/checksum/.test(text)) return "checksum";
  return "exit";
}

function runCommand(command, args, { cwd = root, environment, input, timeout = 120_000 } = {}) {
  if (!environment) throw new Error("Browser smoke subprocess environment is required");
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    input,
    maxBuffer: 2 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    timeout,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const error = new Error("Browser smoke subprocess failed without exposing subprocess output");
    error.safeCategory = safeSubprocessCategory(result);
    throw error;
  }
  return result.stdout ?? "";
}

function composeArgs(identity, ...args) {
  return ["compose", "--project-name", identity.composeProject, "-f", composeFile, ...args];
}

function runCompose(identity, environment, ...args) {
  return runCommand("docker", composeArgs(identity, ...args), {
    environment,
    timeout: 180_000,
  });
}

function runDisposablePsql(identity, target, environment, sql) {
  const invocation = disposablePsqlInvocation(identity, target, composeFile);
  return runCommand(invocation.command, invocation.args, { environment, input: sql });
}

function dockerResourceIds(resource, identity, environment) {
  const invocation = dockerResourceListInvocation(resource, identity.composeProject);
  return runCommand(invocation.command, invocation.args, { environment })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function assertComposeAbsent(identity, environment) {
  if (
    dockerResourceIds("container", identity, environment).length > 0 ||
    dockerResourceIds("network", identity, environment).length > 0 ||
    dockerResourceIds("volume", identity, environment).length > 0
  ) {
    throw new Error("Browser smoke Compose resources remain");
  }
}

function inspectResourceLabel(args, environment) {
  return runCommand("docker", args, { environment }).trim();
}

function verifyComposeResources(identity, environment, expectedServices) {
  const services = runCompose(identity, environment, "ps", "--services", "--status", "running")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
  const expected = [...expectedServices].sort();
  if (
    services.length !== expected.length ||
    services.some((service, index) => service !== expected[index])
  ) {
    throw new Error("Browser smoke Compose services are incomplete");
  }

  for (const service of expectedServices) {
    const output = inspectResourceLabel(
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}',
        identity.containers[service],
      ],
      environment,
    );
    if (output !== `${identity.composeProject}|${service}`) {
      throw new Error("Browser smoke container identity is unexpected");
    }
  }

  const networkProject = inspectResourceLabel(
    [
      "network",
      "inspect",
      "--format",
      '{{index .Labels "com.docker.compose.project"}}',
      identity.networkName,
    ],
    environment,
  );
  const hostNetworkProject = inspectResourceLabel(
    [
      "network",
      "inspect",
      "--format",
      '{{index .Labels "com.docker.compose.project"}}',
      identity.hostNetworkName,
    ],
    environment,
  );
  const volumeProject = inspectResourceLabel(
    [
      "volume",
      "inspect",
      "--format",
      '{{index .Labels "com.docker.compose.project"}}',
      identity.volumeName,
    ],
    environment,
  );
  if (
    networkProject !== identity.composeProject ||
    hostNetworkProject !== identity.composeProject ||
    volumeProject !== identity.composeProject
  ) {
    throw new Error("Browser smoke storage or network identity is unexpected");
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Browser smoke could not allocate a port"));
        else resolve(port);
      });
    });
  });
}

async function allocatePorts(persistentPorts) {
  const keys = ["postgres", "web", "api", "gotrue", "smtp", "mailpit"];
  const ports = {};
  const used = new Set(persistentPorts);
  for (const key of keys) {
    let candidate;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      candidate = await freePort();
      if (!used.has(candidate)) break;
      candidate = undefined;
    }
    if (!candidate) throw new Error("Browser smoke could not allocate isolated ports");
    ports[key] = candidate;
    used.add(candidate);
  }
  assertDisposablePorts(ports, persistentPorts);
  return Object.freeze(ports);
}

async function portOpen(port, signal) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(value);
    };
    const onAbort = () => finish(false);
    socket.setTimeout(500);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function assertPortsClosed(ports, signal) {
  if (
    (await Promise.all(Object.values(ports).map((port) => portOpen(port, signal)))).some(Boolean)
  ) {
    throw new Error("Browser smoke port preflight found an occupied port");
  }
  if (signal?.aborted) throw signal.reason;
}

async function waitForPortsClosed(ports, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await Promise.all(Object.values(ports).map((port) => portOpen(port)));
    if (states.every((open) => !open)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser smoke ports did not close");
}

async function waitForHttp(
  origin,
  path,
  child,
  { expectedContentType, expectHealthBody = false, signal, timeoutMs = 60_000 },
) {
  const expectedUrl = `${origin}${path}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw signal.reason;
    if (child?.managedSpawnError || child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error("Browser smoke managed process exited early");
    }
    try {
      const response = await fetch(expectedUrl, {
        redirect: "error",
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(2_000)])
          : AbortSignal.timeout(2_000),
      });
      assertReadinessMetadata(
        {
          contentType: response.headers.get("content-type"),
          finalUrl: response.url,
          status: response.status,
        },
        { expectedContentType, expectedUrl },
      );
      if (expectHealthBody) assertExactHealthBody(await response.json());
      else await response.arrayBuffer();
      return;
    } catch {
      if (signal?.aborted) throw signal.reason;
      // The isolated service is still starting.
    }
    await delay(200, undefined, signal ? { signal } : undefined);
  }
  throw new Error("Browser smoke managed service did not become ready");
}

function startNode(args, environment, marker) {
  if (!/^agency-workload-smoke-[a-f0-9]{32}-(?:api|auth|browser|web)$/.test(marker)) {
    throw new Error("Browser smoke process marker is invalid");
  }
  const child = spawn(process.execPath, [...args, `--smoke-process-marker=${marker}`], {
    cwd: root,
    env: environment,
    stdio: "ignore",
    windowsHide: true,
    ...managedSpawnOptions(process.platform),
  });
  child.managedProcessGroup = process.platform === "win32" ? null : child.pid;
  child.managedProcessMarker = marker;
  child.managedSpawnError = null;
  child.once("error", () => {
    child.managedSpawnError = true;
  });
  return child;
}

async function waitForChildExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return child.exitCode !== null || child.signalCode !== null;
}

function sendPosixGroupSignal(action) {
  try {
    process.kill(action.target, action.signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function posixProcessGroupExists(processGroup) {
  try {
    process.kill(-processGroup, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForPosixGroupAbsence(processGroup, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!posixProcessGroupExists(processGroup)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !posixProcessGroupExists(processGroup);
}

async function stopProcessTree(child, environment) {
  if (!child) return;
  return stopManagedProcessTree({
    child,
    listWindowsMarkerProcesses: async () =>
      listWindowsMarkerProcesses(child.managedProcessMarker, environment),
    marker: child.managedProcessMarker,
    platform: process.platform,
    runWindows: async (action) =>
      spawnSync(action.command, action.args, {
        encoding: "utf8",
        env: environment,
        stdio: "pipe",
        timeout: 10_000,
        windowsHide: true,
      }),
    sendPosixSignal: sendPosixGroupSignal,
    waitForExit: waitForChildExit,
    waitForGroupAbsence: waitForPosixGroupAbsence,
  });
}

function registerChild(context, role, child) {
  if (!/^(?:api|browser|web)$/.test(role) || context.children.has(role)) {
    throw new Error("Browser smoke child registry update is invalid");
  }
  context.children.set(role, child);
  return child;
}

function liveChildren(context) {
  return ["browser", "web", "api"].flatMap((role) => {
    const child = context.children.get(role);
    return child ? [child] : [];
  });
}

async function finalCleanupRescan(context) {
  for (const child of liveChildren(context)) {
    if (process.platform === "win32") {
      const exact = filterExactWindowsMarkerProcesses(
        listWindowsMarkerProcesses(child.managedProcessMarker, context.childEnvironments.process),
        child.managedProcessMarker,
      );
      if (exact.length > 0) throw new Error("Browser smoke marker descendants remain");
    } else if (
      child.managedProcessGroup &&
      !(await waitForPosixGroupAbsence(child.managedProcessGroup, 500))
    ) {
      throw new Error("Browser smoke process group remains");
    }
  }
  if (context.dockerValidated && context.childEnvironments) {
    assertComposeAbsent(context.identity, context.childEnvironments.compose);
  }
  if (context.ports) {
    await waitForPortsClosed(context.ports);
    await assertPortsClosed(context.ports);
  }
}

async function cleanupDisposableSmoke(context) {
  const failures = [];
  let composeDownFailed = false;
  for (const child of liveChildren(context)) {
    await stopProcessTree(child, context.childEnvironments?.process ?? {}).catch(() =>
      failures.push("process"),
    );
  }
  if (context.dockerValidated && context.composeStarted && context.childEnvironments) {
    try {
      runCompose(
        context.identity,
        context.childEnvironments.compose,
        "down",
        "-v",
        "--remove-orphans",
      );
      context.composeStarted = false;
    } catch {
      composeDownFailed = true;
    }
  }
  if (context.browserProfileDirectory) {
    try {
      await rm(context.browserProfileDirectory, { force: true, recursive: true });
    } catch {
      failures.push("browser-profile");
    }
  }
  try {
    await finalCleanupRescan(context);
  } catch {
    if (composeDownFailed) failures.push("compose-down");
    failures.push("final-rescan");
  }
  if (failures.length > 0) {
    context.cleanupFailures = failures;
    throw new Error("Browser smoke cleanup verification failed");
  }
}

const identity = createSmokeIdentity(generateSmokeSuffix());
const context = {
  browserProfileDirectory: null,
  childEnvironments: null,
  children: new Map(),
  composeStarted: false,
  cleanupFailures: [],
  dockerValidated: false,
  executionStage: "startup",
  executionDetail: "none",
  executionExitCode: 1,
  identity,
  ports: null,
};
const cleanupOnce = createIdempotentCleanup(() => cleanupDisposableSmoke(context));
const shutdown = createShutdownCoordinator({
  cleanup: cleanupOnce,
  exit: (code) => process.exit(code),
});

let executionFailed = false;
let cleanupFailed = false;

async function runSmoke() {
  assertDockerEndpointOverridesSafe(process.env);
  const persistentPorts = persistentPortExclusions();
  await runStartupStep(shutdown, async () => {
    context.ports = await allocatePorts(persistentPorts);
  });
  let configuration;
  await runStartupStep(shutdown, async () => {
    configuration = createSmokeConfiguration(identity, context.ports);
    context.childEnvironments = buildChildEnvironments(configuration, process.env);
    context.browserProfileDirectory = configuration.browserProfileDirectory;
  });

  context.executionStage = "docker-target";
  await runStartupStep(shutdown, async () => {
    const dockerContext = dockerContextInspectInvocation();
    const dockerEndpoint = runCommand(dockerContext.command, dockerContext.args, {
      environment: context.childEnvironments.docker,
      timeout: 10_000,
    }).trim();
    assertLocalDockerEndpoint(dockerEndpoint, process.platform);
    context.dockerValidated = true;
  });

  context.executionStage = "preflight";
  await runStartupStep(shutdown, async (signal) => {
    await assertPortsClosed(context.ports, signal);
    assertComposeAbsent(identity, context.childEnvironments.compose);
  });

  context.executionStage = "compose-foundation-up";
  await runStartupStep(shutdown, async () => {
    context.composeStarted = true;
    runCompose(
      identity,
      context.childEnvironments.compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "postgres",
      "mailpit",
    );
  });
  context.executionStage = "compose-foundation-verify";
  await runStartupStep(shutdown, async () => {
    verifyComposeResources(identity, context.childEnvironments.compose, ["postgres", "mailpit"]);
  });

  context.executionStage = "database-initialization";
  await runStartupStep(shutdown, async () => {
    runDisposablePsql(
      identity,
      "postgres",
      context.childEnvironments.compose,
      buildInitializeClusterSql(configuration, identity),
    );
  });
  await runStartupStep(shutdown, async () => {
    runDisposablePsql(
      identity,
      "application",
      context.childEnvironments.compose,
      buildInitializeDatabaseSql(),
    );
  });
  context.executionStage = "migration";
  await runStartupStep(shutdown, async () => {
    runCommand(process.execPath, [...nodeWithTsx, join(root, "packages", "db", "src", "cli.ts")], {
      environment: context.childEnvironments.migration,
    });
  });

  context.executionStage = "gotrue-startup";
  await runStartupStep(shutdown, async () => {
    runCompose(
      identity,
      context.childEnvironments.compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "120",
      "gotrue",
    );
  });
  await runStartupStep(shutdown, async () => {
    verifyComposeResources(identity, context.childEnvironments.compose, [
      "postgres",
      "mailpit",
      "gotrue",
    ]);
  });

  context.executionStage = "owner-bootstrap";
  await runStartupStep(shutdown, async () => {
    runCommand(
      process.execPath,
      [...nodeWithTsx, join(root, "apps", "api", "src", "bootstrap-owner.ts")],
      { environment: context.childEnvironments.bootstrap },
    );
  });
  context.executionStage = "web-build";
  await runStartupStep(shutdown, async () => {
    runCommand(process.execPath, [viteCli, "build"], {
      cwd: webRoot,
      environment: context.childEnvironments.webBuild,
    });
  });

  context.executionStage = "application-startup";
  await runStartupStep(shutdown, async (signal) => {
    await assertPortsClosed({ web: context.ports.web, api: context.ports.api }, signal);
  });
  const api = await runStartupStep(shutdown, async () =>
    registerChild(
      context,
      "api",
      startNode(
        [...nodeWithTsx, join(root, "apps", "api", "src", "server.ts")],
        context.childEnvironments.api,
        configuration.processMarkers.api,
      ),
    ),
  );
  const web = await runStartupStep(shutdown, async () =>
    registerChild(
      context,
      "web",
      startNode(
        [join(root, "tools", "dev-web.mjs"), "--host", "127.0.0.1"],
        context.childEnvironments.web,
        configuration.processMarkers.web,
      ),
    ),
  );
  await runStartupStep(shutdown, async (signal) => {
    await Promise.all([
      waitForHttp(configuration.apiOrigin, "/healthz", api, {
        expectedContentType: "application/json",
        expectHealthBody: true,
        signal,
      }),
      waitForHttp(configuration.appOrigin, "/login", web, {
        expectedContentType: "text/html",
        signal,
      }),
    ]);
  });

  context.executionStage = "browser";
  const browserChild = await runStartupStep(shutdown, async () =>
    registerChild(
      context,
      "browser",
      startNode(
        [browserFile],
        context.childEnvironments.browser,
        configuration.processMarkers.browser,
      ),
    ),
  );
  await waitForManagedChild(browserChild, {
    cleanup: cleanupOnce,
    label: "browser",
    signal: shutdown.signal,
    timeoutMs: 120_000,
  });
  shutdown.throwIfRequested();
}

const mainPromise = shutdown.startMain(runSmoke);
try {
  await mainPromise;
} catch (error) {
  executionFailed = true;
  context.executionDetail = error?.safeCategory ?? "operation";
  context.executionExitCode =
    Number.isSafeInteger(error?.exitCode) && error.exitCode > 0 && error.exitCode <= 255
      ? error.exitCode
      : 1;
}

if (shutdown.requested) {
  await shutdown.completion;
} else {
  await cleanupOnce().catch(() => {
    cleanupFailed = true;
  });
  shutdown.remove();
}

if (cleanupFailed) {
  console.error(
    `Disposable browser smoke cleanup verification failed (${context.cleanupFailures.join(", ") || "unknown"}).`,
  );
  process.exitCode = 1;
} else if (executionFailed) {
  console.error(
    `Disposable browser smoke execution failed (${context.executionStage}/${context.executionDetail}); inspect sanitized browser evidence when present.`,
  );
  process.exitCode = context.executionExitCode;
} else {
  console.log("Disposable browser smoke passed.");
  console.log("PostgreSQL, GoTrue, and Mailpit ran only in the disposable Compose project.");
  console.log("Compose resources, process trees, and host ports were removed.");
}
