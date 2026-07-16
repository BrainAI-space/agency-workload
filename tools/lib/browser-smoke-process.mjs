export function createIdempotentCleanup(cleanup) {
  let cleanupPromise;
  return () => {
    cleanupPromise ??= Promise.resolve().then(cleanup);
    return cleanupPromise;
  };
}

function shutdownError() {
  const error = new Error("Browser smoke shutdown was requested");
  error.safeCategory = "shutdown";
  return error;
}

export function createShutdownCoordinator({ cleanup, exit, target = process }) {
  const controller = new AbortController();
  let requested = false;
  let mainPromise;
  let resolveMainReady;
  let completionPromise = Promise.resolve();
  const mainReady = new Promise((resolve) => {
    resolveMainReady = resolve;
  });
  const handlers = new Map();

  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      if (requested) return;
      requested = true;
      controller.abort(shutdownError());
      completionPromise = (async () => {
        const activeMain = await mainReady;
        await activeMain.promise.catch(() => undefined);
        try {
          await cleanup();
          exit(exitCode);
        } catch {
          exit(1);
        }
      })();
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }

  const coordinator = {
    get completion() {
      return completionPromise;
    },
    get requested() {
      return requested;
    },
    signal: controller.signal,
    remove() {
      for (const [signal, handler] of handlers) target.off(signal, handler);
    },
    startMain(action) {
      if (mainPromise) throw new Error("Browser smoke main lifecycle is already started");
      mainPromise = Promise.resolve().then(action);
      resolveMainReady({ promise: mainPromise });
      return mainPromise;
    },
    throwIfRequested() {
      if (requested || controller.signal.aborted) throw shutdownError();
    },
  };
  return coordinator;
}

export async function runStartupStep(shutdown, action) {
  shutdown.throwIfRequested();
  const result = await action(shutdown.signal);
  await new Promise((resolve) => setImmediate(resolve));
  shutdown.throwIfRequested();
  return result;
}

export function installSignalHandlers({ cleanup, exit, target = process }) {
  const handlers = new Map();
  let handlingSignal = false;
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      if (handlingSignal) return;
      handlingSignal = true;
      void Promise.resolve()
        .then(cleanup)
        .then(
          () => exit(exitCode),
          () => exit(1),
        );
    };
    handlers.set(signal, handler);
    target.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) target.off(signal, handler);
  };
}

export function managedSpawnOptions(platform) {
  return { detached: platform !== "win32" };
}

function childIsRunning(child) {
  return (
    Number.isSafeInteger(child?.pid) &&
    child.pid > 0 &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

export function processTerminationAction(platform, child, signal = "SIGTERM") {
  if (platform === "win32") {
    if (!childIsRunning(child)) return null;
    return {
      command: "taskkill",
      args: ["/pid", String(child.pid), "/t", "/f"],
    };
  }
  const processGroup = child?.managedProcessGroup ?? child?.pid;
  if (!Number.isSafeInteger(processGroup) || processGroup < 1) return null;
  return { signal, target: -processGroup };
}

function validateProcessMarker(marker) {
  if (
    !/^agency-workload-smoke-[a-f0-9]{32}-(?:api|auth|browser|web|db|admin|planning|extended)$/.test(
      marker,
    )
  ) {
    throw new Error("Managed Windows process marker is invalid");
  }
}

function exactMarkerPattern(marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[\\s"])(?:--smoke-process-marker|--agency-workload-smoke-marker)=${escaped}(?=$|[\\s"])`,
  );
}

export function filterExactWindowsMarkerProcesses(records, marker) {
  validateProcessMarker(marker);
  const pattern = exactMarkerPattern(marker);
  return records.flatMap((record) => {
    const processId = record?.processId ?? record?.ProcessId;
    const commandLine = record?.commandLine ?? record?.CommandLine;
    if (
      !Number.isSafeInteger(processId) ||
      processId < 1 ||
      typeof commandLine !== "string" ||
      !pattern.test(commandLine)
    ) {
      return [];
    }
    return [{ commandLine, processId }];
  });
}

export async function terminateWindowsMarkerProcesses({
  knownExitedPid = null,
  listExactProcesses,
  marker,
  now = Date.now,
  runTaskkill,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 5_000,
}) {
  validateProcessMarker(marker);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const candidates = filterExactWindowsMarkerProcesses(await listExactProcesses(), marker);
    if (candidates.length === 0) return;
    for (const candidate of candidates) {
      if (candidate.processId === knownExitedPid) continue;
      const current = filterExactWindowsMarkerProcesses(await listExactProcesses(), marker);
      if (!current.some((record) => record.processId === candidate.processId)) continue;
      const result = await runTaskkill({
        command: "taskkill",
        args: ["/pid", String(candidate.processId), "/t", "/f"],
      });
      if (Number.isSafeInteger(result?.status) && result.status !== 0) {
        throw new Error("Managed Windows marker process did not stop");
      }
    }
    await sleep(50);
  }
  const residuals = filterExactWindowsMarkerProcesses(await listExactProcesses(), marker);
  if (residuals.length > 0) throw new Error("Managed Windows marker processes remain");
}

function managedChildExitError(label, exitCode, signalCode) {
  const error = new Error(`${label} managed child exited unsuccessfully`);
  error.safeCategory = exitCode === null ? "signal" : "exit";
  error.exitCode = exitCode;
  error.signalCode = signalCode;
  return error;
}

export function waitForManagedChild(
  child,
  { cleanup, label, signal, timeoutMs, setTimer = setTimeout, clearTimer = clearTimeout },
) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Managed child timeout is invalid");
  }
  if (!child || typeof child.once !== "function" || typeof child.off !== "function") {
    throw new Error("Managed child is invalid");
  }
  if (typeof cleanup !== "function" || !/^[a-z][a-z0-9-]*$/.test(label)) {
    throw new Error("Managed child lifecycle configuration is invalid");
  }
  if (signal?.aborted) return Promise.reject(signal.reason ?? shutdownError());

  const completed = () => child.exitCode !== null || child.signalCode !== null;
  if (child.managedSpawnError) {
    const error = new Error(`${label} managed child failed to spawn`);
    error.safeCategory = "spawn";
    return Promise.reject(error);
  }
  if (completed()) {
    return child.exitCode === 0
      ? Promise.resolve({ exitCode: 0, signalCode: child.signalCode })
      : Promise.reject(managedChildExitError(label, child.exitCode, child.signalCode));
  }

  return new Promise((resolve, reject) => {
    let state = "pending";
    let timer;
    const removeListeners = () => {
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      if (state !== "pending") return;
      state = "shutdown";
      clearTimer(timer);
      removeListeners();
      reject(signal.reason ?? shutdownError());
    };
    const onError = () => {
      if (state !== "pending") return;
      state = "spawn-error";
      clearTimer(timer);
      removeListeners();
      const error = new Error(`${label} managed child failed to spawn`);
      error.safeCategory = "spawn";
      reject(error);
    };
    const onExit = (exitCode, signalCode) => {
      if (state !== "pending") return;
      state = "exited";
      clearTimer(timer);
      removeListeners();
      if (exitCode === 0) resolve({ exitCode, signalCode });
      else reject(managedChildExitError(label, exitCode, signalCode));
    };

    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (completed()) {
      onExit(child.exitCode, child.signalCode);
      return;
    }

    timer = setTimer(async () => {
      if (state !== "pending") return;
      state = "timed-out";
      clearTimer(timer);
      removeListeners();
      let cleanupFailed = false;
      try {
        await cleanup();
      } catch {
        cleanupFailed = true;
      }
      const error = new Error(`${label} managed child timed out`);
      error.safeCategory = cleanupFailed ? "timeout-cleanup" : "timeout";
      reject(error);
    }, timeoutMs);
  });
}

export async function stopManagedProcessTree({
  child,
  listWindowsMarkerProcesses,
  marker = child?.managedProcessMarker,
  platform,
  runWindows,
  sendPosixSignal,
  verifyWindowsLeaderMarker,
  verifyWindowsMarkerAbsent,
  waitForExit,
  waitForGroupAbsence,
  terminateTimeoutMs = 5_000,
  killTimeoutMs = 5_000,
}) {
  if (platform === "win32") {
    if (typeof listWindowsMarkerProcesses === "function") {
      await terminateWindowsMarkerProcesses({
        knownExitedPid: childIsRunning(child) ? null : child?.pid,
        listExactProcesses: listWindowsMarkerProcesses,
        marker,
        runTaskkill: runWindows,
        timeoutMs: terminateTimeoutMs,
      });
      return;
    }
    const current = processTerminationAction(platform, child, "SIGTERM");
    if (current) {
      if (typeof verifyWindowsLeaderMarker !== "function") {
        throw new Error("Managed Windows leader ownership cannot be proven");
      }
      if (await verifyWindowsLeaderMarker(child.pid)) {
        const result = await runWindows(current);
        if (result.status !== 0) {
          if (!(await waitForExit(child, 500))) {
            throw new Error("Managed Windows process tree did not stop");
          }
        } else if (!(await waitForExit(child, terminateTimeoutMs))) {
          throw new Error("Managed Windows process tree remained active");
        }
      }
    }
    if (typeof verifyWindowsMarkerAbsent !== "function") {
      throw new Error("Managed Windows descendant absence cannot be proven");
    }
    await verifyWindowsMarkerAbsent();
    return;
  }

  const initial = processTerminationAction(platform, child, "SIGTERM");
  if (!initial) return;
  if (typeof waitForGroupAbsence !== "function") {
    throw new Error("Managed POSIX process-group absence cannot be proven");
  }
  sendPosixSignal(initial);
  if (await waitForGroupAbsence(-initial.target, terminateTimeoutMs)) return;
  const force = processTerminationAction(platform, child, "SIGKILL");
  if (force) sendPosixSignal(force);
  if (!(await waitForGroupAbsence(-initial.target, killTimeoutMs))) {
    throw new Error("Managed POSIX process group remained active");
  }
}
