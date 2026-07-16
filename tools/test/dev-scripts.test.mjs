import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root web development script has an explicit Vite root and supports smoke overrides", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const command = manifest.scripts["dev:web"];
  assert.equal(command, "node tools/dev-web.mjs");
  assert.doesNotMatch(command, /npm run/);
  const launcher = await readFile(new URL("../dev-web.mjs", import.meta.url), "utf8");
  assert.match(launcher, /join\(root, "apps", "web"\)/);
  assert.match(launcher, /strictPort: true/);
  assert.match(launcher, /process\.env\.SMOKE_WEB_PORT/);
  assert.match(launcher, /process\.env\.SMOKE_API_ORIGIN/);
  assert.match(launcher, /proxy: \{ "\/api": parsedApiOrigin\.origin \}/);
});

test("web tests resolve setup from an explicit module-relative Vite root", async () => {
  const config = await readFile(new URL("../../apps/web/vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /const webRoot = fileURLToPath\(new URL\(".", import\.meta\.url\)\)/);
  assert.match(config, /root: webRoot/);
  assert.match(config, /setupFiles:\s*"\.\/src\/test\/setup\.ts"/);
});
