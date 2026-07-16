import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import test from "node:test";

import { managedSpawnOptions, stopManagedProcessTree } from "../lib/browser-smoke-process.mjs";
import { listWindowsMarkerProcesses } from "../lib/browser-smoke-windows.mjs";

function waitForChildExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once("exit", onExit);
  });
}

function waitForReady(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      child.stdout.off("data", onData);
      reject(new Error("Process tree did not emit a ready handshake"));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("READY:"));
      if (!line) return;
      const match = line.match(/^READY:([a-z0-9-]+):(\d+)$/);
      if (!match || match[1] !== marker) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        reject(new Error("Process tree emitted an invalid ready handshake"));
        return;
      }
      const descendantPid = Number(match[2]);
      if (!Number.isSafeInteger(descendantPid) || descendantPid < 1) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        reject(new Error("Process tree emitted an invalid descendant PID"));
        return;
      }
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolve(descendantPid);
    };
    child.stdout.on("data", onData);
  });
}

function processExists(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

test("real Windows production marker cleanup removes a ready child and descendant", {
  skip: process.platform !== "win32",
  timeout: 30_000,
}, async () => {
  const marker = `agency-workload-smoke-${randomBytes(16).toString("hex")}-browser`;
  const descendantSource = "setInterval(() => undefined, 1000)";
  const leaderSource = [
    "const { spawn } = require('node:child_process')",
    "const markerArg = process.argv[1]",
    "const marker = markerArg.slice('--smoke-process-marker='.length)",
    `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}, '--', markerArg], { stdio: 'ignore' })`,
    "process.stdout.write('READY:' + marker + ':' + descendant.pid + '\\n')",
    "setInterval(() => undefined, 1000)",
  ].join("; ");
  const child = spawn(
    process.execPath,
    ["-e", leaderSource, "--", `--smoke-process-marker=${marker}`],
    {
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      ...managedSpawnOptions(process.platform),
    },
  );
  child.managedProcessGroup = process.platform === "win32" ? null : child.pid;
  child.managedProcessMarker = marker;
  const descendantPid = await waitForReady(child, marker, 5_000);
  assert.equal(processExists(descendantPid), true);
  assert.ok(
    listWindowsMarkerProcesses(marker, process.env).some(
      (record) => record.processId === descendantPid,
    ),
  );

  try {
    await stopManagedProcessTree({
      child,
      listWindowsMarkerProcesses: async () => listWindowsMarkerProcesses(marker, process.env),
      marker,
      platform: "win32",
      runWindows: async (action) =>
        spawnSync(action.command, action.args, {
          encoding: "utf8",
          stdio: "pipe",
          timeout: 10_000,
          windowsHide: true,
        }),
      waitForExit: waitForChildExit,
    });
    assert.equal(await waitForChildExit(child, 1_000), true);
    assert.equal(processExists(descendantPid), false);
    assert.deepEqual(listWindowsMarkerProcesses(marker, process.env), []);
  } finally {
    for (const record of listWindowsMarkerProcesses(marker, process.env)) {
      spawnSync("taskkill", ["/pid", String(record.processId), "/t", "/f"], {
        stdio: "ignore",
        timeout: 10_000,
        windowsHide: true,
      });
    }
  }
});
