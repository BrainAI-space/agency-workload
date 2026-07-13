import { spawnSync } from "node:child_process";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { databaseUrlRules, directSecretKeys, parseEnv } from "./lib/config.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const publicRoot = join(root, "..", "public");
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "backups",
  "coverage",
  "dist",
  "logs",
  "node_modules",
  "playwright-report",
  "runtime",
  "secrets",
  "temp",
  "test-results",
  "tmp",
  "uploads",
]);
const failures = [];

let values;
try {
  values = parseEnv(await readFile(join(root, ".env"), "utf8"));
} catch {
  console.error("Local secret safety verification requires a valid ignored .env file.");
  process.exit(1);
}

const secrets = directSecretKeys.map((key) => values.get(key) ?? "");
for (const key of Object.keys(databaseUrlRules)) {
  const value = values.get(key);
  if (!value) continue;
  secrets.push(value, decodeURIComponent(new URL(value).password));
}
const exactSecrets = secrets.filter((value) => value.length >= 16);

async function scan(directory, label, scanRoot) {
  for (const name of await readdir(directory)) {
    if (
      ignoredDirectories.has(name) ||
      (/^\.env(?:\.|$)/.test(name) && !name.endsWith(".example")) ||
      /\.(?:bak|dump|log|trace)$/i.test(name)
    ) {
      continue;
    }
    const path = join(directory, name);
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await scan(path, label, scanRoot);
      continue;
    }
    if (entry.size > 1_048_576) continue;
    const content = await readFile(path, "utf8");
    if (exactSecrets.some((secret) => content.includes(secret))) {
      failures.push(`${label} file contains a local secret: ${relative(scanRoot, path)}`);
    }
  }
}

await scan(root, "canonical", root);
await scan(publicRoot, "public", publicRoot);

for (const service of ["agency-workload-auth-1", "agency-workload-mailpit-1"]) {
  const result = spawnSync("docker", ["logs", "--tail", "1000", service], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (exactSecrets.some((secret) => output.includes(secret))) {
    failures.push(`container logs contain a local secret: ${service}`);
  }
}

if (failures.length > 0) {
  console.error(`Local secret safety verification failed (${failures.length} findings):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Verified local secret values are absent from repository files and service logs.");
