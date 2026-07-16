import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDisposableAuthIntegration } from "./lib/disposable-auth-integration.mjs";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
await runDisposableAuthIntegration({
  root,
  testFile: join("apps", "api", "test", "auth.integration.test.ts"),
});
