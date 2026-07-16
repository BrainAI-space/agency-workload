import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runDisposablePostgresIntegration } from "./lib/disposable-postgres-integration.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
await runDisposablePostgresIntegration({
  root,
  suite: "planning",
  testFile: "apps/api/test/planning.integration.test.ts",
});
