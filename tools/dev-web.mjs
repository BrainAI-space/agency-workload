import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, preview } from "vite";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const webRoot = join(root, "apps", "web");
const hostIndex = process.argv.indexOf("--host");
const hostArgument = process.argv.find((argument) => argument.startsWith("--host="));
const host =
  (hostIndex >= 0 ? process.argv[hostIndex + 1] : undefined) ??
  hostArgument?.slice("--host=".length) ??
  "127.0.0.1";
const port = Number(process.env.SMOKE_WEB_PORT ?? 3100);
const apiOrigin = process.env.SMOKE_API_ORIGIN ?? "http://127.0.0.1:4100";
const usePreview = process.env.SMOKE_WEB_MODE === "preview";

if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("Web development port is invalid");
}
const parsedApiOrigin = new URL(apiOrigin);
if (
  parsedApiOrigin.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(parsedApiOrigin.hostname) ||
  !parsedApiOrigin.port ||
  parsedApiOrigin.pathname !== "/" ||
  parsedApiOrigin.search ||
  parsedApiOrigin.hash
) {
  throw new Error("Web API proxy origin is invalid");
}

const shared = {
  root: webRoot,
  configFile: join(webRoot, "vite.config.ts"),
};
const network = { host, port, strictPort: true, proxy: { "/api": parsedApiOrigin.origin } };
const server = usePreview
  ? await preview({ ...shared, preview: network })
  : await createServer({ ...shared, server: network });

if (!usePreview) await server.listen();
server.printUrls();
