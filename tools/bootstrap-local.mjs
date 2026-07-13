import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bootstrapLocal, rotateLocalSecrets, rotationSummaryLines } from "./lib/bootstrap.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const rotateMode = process.argv.includes("--rotate-secrets");
const confirmed = process.argv.includes("--confirm-rotation");
let servicesStopped = false;

function runCompose(action) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      "agency-workload",
      "--env-file",
      ".env",
      "-f",
      "infra/compose.dev.yml",
      ...action,
    ],
    { cwd: root, encoding: "utf8", windowsHide: true },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Local auth service operation failed without exposing subprocess output");
  }
}

async function verifyServiceRoleRotation(previousValues, currentValues) {
  const request = (token) =>
    fetch("http://127.0.0.1:9999/admin/users?page=1&per_page=1", {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });

  const previousResponse = await request(previousValues.get("GOTRUE_SERVICE_ROLE_KEY"));
  if (![401, 403].includes(previousResponse.status)) {
    throw new Error("Previous service-role token was not rejected");
  }

  const currentResponse = await request(currentValues.get("GOTRUE_SERVICE_ROLE_KEY"));
  if (!currentResponse.ok) throw new Error("Rotated service-role token was not accepted");
}

try {
  if (rotateMode) {
    if (!confirmed) throw new Error("Secret rotation requires --confirm-rotation");
    runCompose(["down"]);
    servicesStopped = true;
    const result = await rotateLocalSecrets({
      confirmed: true,
      root,
      async postRotationVerify({ currentValues, previousValues }) {
        runCompose(["up", "-d", "--wait"]);
        servicesStopped = false;
        await verifyServiceRoleRotation(previousValues, currentValues);
      },
    });
    for (const line of rotationSummaryLines(result)) console.log(line);
    console.log("Rejected the previous service-role token and accepted the rotated token.");
    console.log("Restarted local GoTrue and Mailpit with the rotated configuration.");
  } else {
    if (confirmed) throw new Error("--confirm-rotation requires --rotate-secrets");
    const result = await bootstrapLocal({ root });
    console.log(
      result.environmentChanged
        ? "Created private local configuration."
        : "Kept existing local configuration.",
    );
    console.log("Prepared the approved local PostgreSQL database, roles, and schemas.");
  }
} catch (error) {
  if (rotateMode) {
    if (servicesStopped) {
      try {
        runCompose(["up", "-d", "--wait"]);
      } catch {
        // The fixed failure below intentionally avoids subprocess and secret output.
      }
    }
    console.error("Local secret rotation failed without exposing sensitive diagnostics.");
  } else {
    console.error(error instanceof Error ? error.message : "Local bootstrap failed safely.");
  }
  process.exitCode = 1;
}
