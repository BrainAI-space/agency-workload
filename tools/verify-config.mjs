import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { parseEnv, validateConfiguration } from "./lib/config.mjs";

const mode = process.argv[2] ?? "--template";
const path = process.argv[3] ?? (mode === "--runtime" ? ".env" : ".env.example");
if (!["--template", "--runtime"].includes(mode)) {
  console.error("Usage: node tools/verify-config.mjs --template|--runtime <file>");
  process.exit(1);
}

try {
  const values = parseEnv(await readFile(resolve(process.cwd(), path), "utf8"));
  const failures = validateConfiguration(values, { template: mode === "--template" });
  if (failures.length > 0) {
    console.error(`Configuration verification failed (${failures.length} findings):`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  console.log(`Verified ${values.size} ${mode === "--template" ? "template" : "runtime"} keys.`);
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Configuration verification failed safely.",
  );
  process.exit(1);
}
