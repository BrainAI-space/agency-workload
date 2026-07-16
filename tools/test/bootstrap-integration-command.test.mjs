import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BOOTSTRAP_CANONICAL_ONLY_MESSAGE,
  BOOTSTRAP_INTEGRATION_TIMEOUT_MS,
  BOOTSTRAP_UNKNOWN_ORIGIN_MESSAGE,
  runBootstrapIntegrationCommand,
} from "../bootstrap-integration-command.mjs";
import {
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
} from "../public-mirror-command.mjs";

test("package routes bootstrap integration through the origin guard", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    manifest.scripts["test:bootstrap:integration"],
    "node tools/bootstrap-integration-command.mjs",
  );
});

test("bootstrap guard is allowlisted only through recognized repository origins", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const origin = readExactOrigin(root);

  if (origin === PRIVATE_CANONICAL_ORIGIN) {
    const allowlist = JSON.parse(
      await readFile(new URL("../public-files.json", import.meta.url), "utf8"),
    ).include;
    assert.ok(allowlist.includes("tools/bootstrap-integration-command.mjs"));
    return;
  }

  if (origin === PUBLIC_MIRROR_ORIGIN) {
    await assert.rejects(readFile(new URL("../public-files.json", import.meta.url)), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
    assert.throws(
      () => runBootstrapIntegrationCommand({ origin, root }),
      (error) => error.message === BOOTSTRAP_CANONICAL_ONLY_MESSAGE,
    );
    return;
  }

  assert.fail(`Tool tests do not support repository origin: ${origin}`);
});

test("private canonical origin spawns only the current bootstrap integration with a fixed timeout", () => {
  const root = "C:\\canonical";
  const calls = [];
  runBootstrapIntegrationCommand({
    execute(command, args, options) {
      calls.push({ args, command, options });
      return { status: 0 };
    },
    origin: PRIVATE_CANONICAL_ORIGIN,
    root,
  });

  assert.deepEqual(calls, [
    {
      args: [join(root, "tools", "test", "bootstrap.integration.mjs"), "--integration"],
      command: process.execPath,
      options: {
        cwd: root,
        stdio: "inherit",
        timeout: BOOTSTRAP_INTEGRATION_TIMEOUT_MS,
        windowsHide: true,
      },
    },
  ]);
});

test("public origin refuses before spawning the bootstrap integration", () => {
  let executed = false;
  assert.throws(
    () =>
      runBootstrapIntegrationCommand({
        execute() {
          executed = true;
          throw new Error("must not spawn");
        },
        origin: PUBLIC_MIRROR_ORIGIN,
        root: join(tmpdir(), "missing-public-checkout"),
      }),
    (error) => {
      assert.equal(error.message, BOOTSTRAP_CANONICAL_ONLY_MESSAGE);
      return true;
    },
  );
  assert.equal(executed, false);
});

test("unknown origin fails closed before spawning", () => {
  let executed = false;
  assert.throws(
    () =>
      runBootstrapIntegrationCommand({
        execute() {
          executed = true;
          return { status: 0 };
        },
        origin: "git@github.com:someone-else/agency-workload.git",
        root: "C:\\unknown",
      }),
    (error) => {
      assert.equal(error.message, BOOTSTRAP_UNKNOWN_ORIGIN_MESSAGE);
      return true;
    },
  );
  assert.equal(executed, false);
});

test("public CLI refusal occurs before child import or mutation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "agency-workload-bootstrap-public-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "tools", "test"), { recursive: true });

  for (const file of ["bootstrap-integration-command.mjs", "public-mirror-command.mjs"]) {
    await writeFile(
      join(root, "tools", file),
      await readFile(new URL(`../${file}`, import.meta.url)),
    );
  }
  await writeFile(
    join(root, "tools", "test", "bootstrap.integration.mjs"),
    'import { writeFile } from "node:fs/promises"; await writeFile(new URL("../../mutated", import.meta.url), "mutated");\n',
  );

  for (const args of [
    ["init", "--quiet"],
    ["remote", "add", "origin", PUBLIC_MIRROR_ORIGIN],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }

  const result = spawnSync(process.execPath, ["tools/bootstrap-integration-command.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr.trim(), BOOTSTRAP_CANONICAL_ONLY_MESSAGE);
  await assert.rejects(access(join(root, "mutated")), (error) => {
    assert.equal(error.code, "ENOENT");
    return true;
  });
});

test("bootstrap guard source has no environment-file or private implementation import", async () => {
  const source = await readFile(
    new URL("../bootstrap-integration-command.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /--env-file|loadEnvFile|dotenv|readFile/);
  assert.doesNotMatch(source, /import\s+.*bootstrap\.integration/);
});
