import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const PRIVATE_CANONICAL_ORIGIN = "git@github.com:ai-gen-codes/agency-workload.git";
export const PUBLIC_MIRROR_ORIGIN = "git@github.com:BrainAI-space/agency-workload.git";
export const CANONICAL_SYNC_ONLY_MESSAGE =
  "Public mirror synchronization is available only from the private canonical repository.";
export const UNKNOWN_ORIGIN_MESSAGE =
  "Refusing public mirror command from an unknown origin remote.";

const INVALID_COMMAND_MESSAGE = "Public mirror command must be either sync or verify.";
const ORIGIN_READ_FAILURE_MESSAGE = "Unable to read the repository origin remote safely.";
const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

export function readExactOrigin(root, { execute = execFileSync } = {}) {
  try {
    const origin = execute("git", ["remote", "get-url", "origin"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    if (!origin || origin.includes("\n") || origin.includes("\r")) {
      throw new Error(ORIGIN_READ_FAILURE_MESSAGE);
    }
    return origin;
  } catch {
    throw new Error(ORIGIN_READ_FAILURE_MESSAGE);
  }
}

export async function runPublicMirrorCommand(
  command,
  {
    importModule = (specifier) => import(specifier),
    logger = console,
    origin,
    root = projectRoot,
  } = {},
) {
  if (command !== "sync" && command !== "verify") {
    throw new Error(INVALID_COMMAND_MESSAGE);
  }

  const exactOrigin = origin ?? readExactOrigin(root);
  if (exactOrigin === PRIVATE_CANONICAL_ORIGIN) {
    const implementation = command === "sync" ? "./sync-public.mjs" : "./verify-public.mjs";
    await importModule(new URL(implementation, import.meta.url).href);
    return undefined;
  }

  if (exactOrigin === PUBLIC_MIRROR_ORIGIN) {
    if (command === "sync") throw new Error(CANONICAL_SYNC_ONLY_MESSAGE);

    const { verifyPublicCheckout } = await importModule(
      new URL("./lib/public-mirror-self-verify.mjs", import.meta.url).href,
    );
    const result = await verifyPublicCheckout(root);
    logger.log(
      `Verified ${result.fileCount} public files with no blocked paths or secret signatures.`,
    );
    return result;
  }

  throw new Error(UNKNOWN_ORIGIN_MESSAGE);
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    await runPublicMirrorCommand(process.argv[2]);
  } catch (error) {
    if (Array.isArray(error?.failures)) {
      console.error("Public mirror verification failed:\n");
      for (const failure of error.failures) console.error(`- ${failure}`);
    } else {
      console.error(error instanceof Error ? error.message : "Public mirror command failed.");
    }
    process.exitCode = 1;
  }
}
