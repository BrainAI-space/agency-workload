import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const webRoot = join(root, "apps", "web");
const hostIndex = process.argv.indexOf("--host");
const hostArgument = process.argv.find((argument) => argument.startsWith("--host="));
const host =
  (hostIndex >= 0 ? process.argv[hostIndex + 1] : undefined) ??
  hostArgument?.slice("--host=".length) ??
  "127.0.0.1";

const server = await createServer({
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
  server: { host, port: 3100, strictPort: true },
});

await server.listen();
server.printUrls();
