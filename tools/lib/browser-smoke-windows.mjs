import { spawnSync } from "node:child_process";
import { filterExactWindowsMarkerProcesses } from "./browser-smoke-process.mjs";

export function listWindowsMarkerProcesses(
  marker,
  environment,
  run = spawnSync,
  timeoutMs = 10_000,
) {
  const markerEnvironment = { ...environment, SMOKE_PROCESS_MARKER: marker };
  const script = [
    "$marker = $env:SMOKE_PROCESS_MARKER",
    "@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $marker + '*') } | Select-Object ProcessId,CommandLine) | ConvertTo-Json -Compress",
  ].join("; ");
  const result = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    env: markerEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Managed Windows marker query failed");
  }
  const output = (result.stdout ?? "").trim();
  if (!output) return [];
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Error("Managed Windows marker query was invalid");
  }
  return filterExactWindowsMarkerProcesses(Array.isArray(parsed) ? parsed : [parsed], marker);
}
