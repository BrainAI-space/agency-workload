import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
} from "./public-mirror-command.mjs";

export const BOOTSTRAP_INTEGRATION_TIMEOUT_MS = 300_000;
export const BOOTSTRAP_CANONICAL_ONLY_MESSAGE =
  "Bootstrap integration is available only from the private canonical repository. It verifies the canonical local role bootstrap against the optional persistent development database and is not a public clean-clone gate. Use npm run verify for public clean-clone verification.";
export const BOOTSTRAP_UNKNOWN_ORIGIN_MESSAGE =
  "Refusing bootstrap integration command from an unknown origin remote.";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function runBootstrapIntegrationCommand({
  execute = spawnSync,
  origin,
  root = projectRoot,
} = {}) {
  const exactOrigin = origin ?? readExactOrigin(root);
  if (exactOrigin === PUBLIC_MIRROR_ORIGIN) {
    throw new Error(BOOTSTRAP_CANONICAL_ONLY_MESSAGE);
  }
  if (exactOrigin !== PRIVATE_CANONICAL_ORIGIN) {
    throw new Error(BOOTSTRAP_UNKNOWN_ORIGIN_MESSAGE);
  }

  const result = execute(
    process.execPath,
    [join(root, "tools", "test", "bootstrap.integration.mjs"), "--integration"],
    {
      cwd: root,
      stdio: "inherit",
      timeout: BOOTSTRAP_INTEGRATION_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new Error("Bootstrap integration command failed.");
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    runBootstrapIntegrationCommand();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Bootstrap integration command failed.");
    process.exitCode = 1;
  }
}
