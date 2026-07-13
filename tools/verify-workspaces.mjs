import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const expected = [
  ["apps/api", "@agency-workload/api"],
  ["apps/web", "@agency-workload/web"],
  ["packages/contracts", "@agency-workload/contracts"],
  ["packages/db", "@agency-workload/db"],
];

const failures = [];

for (const [directory, expectedName] of expected) {
  try {
    const manifestPath = join(root, directory, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

    if (manifest.name !== expectedName) {
      failures.push(`${directory}: expected package name ${expectedName}`);
    }

    if (manifest.private !== true) {
      failures.push(`${directory}: workspace must be private`);
    }
  } catch (error) {
    failures.push(
      `${directory}: ${error instanceof Error ? error.message : "unreadable manifest"}`,
    );
  }
}

if (failures.length > 0) {
  console.error("Workspace verification failed:\n");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Verified ${expected.length} Agency Workload workspaces.`);
