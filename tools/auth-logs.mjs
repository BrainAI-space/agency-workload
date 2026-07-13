import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { databaseUrlRules, directSecretKeys, parseEnv } from "./lib/config.mjs";
import { redactSensitiveText } from "./lib/redact.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
let exactValues = [];

try {
  const values = parseEnv(await readFile(`${root}/.env`, "utf8"));
  exactValues = directSecretKeys.map((key) => values.get(key) ?? "");
  for (const key of Object.keys(databaseUrlRules)) {
    if (!values.has(key)) continue;
    exactValues.push(values.get(key), decodeURIComponent(new URL(values.get(key)).password));
  }
} catch {
  // Pattern redaction still applies when no local environment exists.
}

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
    "logs",
    "--tail=100",
  ],
  { cwd: root, encoding: "utf8", windowsHide: true },
);

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
if (output) process.stdout.write(redactSensitiveText(output, exactValues));
if (result.error || result.status !== 0) process.exitCode = 1;
