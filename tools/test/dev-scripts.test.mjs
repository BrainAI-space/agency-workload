import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("root web development script has an explicit Vite root and forwards CLI flags", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  const command = manifest.scripts["dev:web"];
  assert.equal(command, "node tools/dev-web.mjs");
  assert.doesNotMatch(command, /npm run/);
  const launcher = await readFile(new URL("../dev-web.mjs", import.meta.url), "utf8");
  assert.match(launcher, /join\(root, "apps", "web"\)/);
  assert.match(launcher, /strictPort: true/);
});

test("browser smoke failure evidence is sanitized and ignored", async () => {
  const smoke = await readFile(new URL("../browser-smoke.mjs", import.meta.url), "utf8");
  assert.match(smoke, /element\.value = ""/);
  assert.match(smoke, /\[redacted-email\]/);
  assert.match(smoke, /test-results/);
  const ignore = await readFile(new URL("../../.gitignore", import.meta.url), "utf8");
  assert.match(ignore, /^test-results\/$/m);
});
