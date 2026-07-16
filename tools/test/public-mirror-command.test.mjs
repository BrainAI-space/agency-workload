import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  isPublicTreeIgnoredEntry,
  isSyncSourceIgnoredEntry,
} from "../lib/public-generated-files.mjs";
import {
  PublicMirrorVerificationError,
  verifyPublicCheckout,
} from "../lib/public-mirror-self-verify.mjs";
import { uniqueSortedPaths } from "../lib/public-sync-files.mjs";
import {
  CANONICAL_SYNC_ONLY_MESSAGE,
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
  runPublicMirrorCommand,
  UNKNOWN_ORIGIN_MESSAGE,
} from "../public-mirror-command.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

test("package scripts route both public commands through the allowlisted wrapper", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../package.json", import.meta.url), "utf8"),
  );

  assert.equal(manifest.scripts["public:sync"], "node tools/public-mirror-command.mjs sync");
  assert.equal(manifest.scripts["public:verify"], "node tools/public-mirror-command.mjs verify");
});

async function createValidPublicFixture(extraFiles = {}, fixtureRoot) {
  const root = fixtureRoot ?? (await mkdtemp(join(tmpdir(), "agency-workload-public-")));
  await mkdir(root, { recursive: true });
  const files = {
    "README.md": "# Public fixture\n",
    "tools/check.mjs": 'console.log("safe");\n',
    ...extraFiles,
  };

  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content, "utf8");
  }

  const manifest = {
    generatedBy: "tools/sync-public.mjs",
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, sha256(content)]),
    ),
  };
  await writeFile(
    join(root, ".mirror-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  return { files, manifest, root };
}

test("origin lookup uses fixed git arguments without a shell", () => {
  const calls = [];
  const origin = readExactOrigin("C:\\safe checkout", {
    execute(command, args, options) {
      calls.push({ args, command, options });
      return `${PRIVATE_CANONICAL_ORIGIN}\n`;
    },
  });

  assert.equal(origin, PRIVATE_CANONICAL_ORIGIN);
  assert.deepEqual(calls, [
    {
      args: ["remote", "get-url", "origin"],
      command: "git",
      options: {
        cwd: "C:\\safe checkout",
        encoding: "utf8",
        windowsHide: true,
      },
    },
  ]);
});

test("private canonical commands dynamically import only their private implementation", async () => {
  const imports = [];
  const importModule = async (specifier) => {
    imports.push(String(specifier));
    return {};
  };

  await runPublicMirrorCommand("sync", {
    importModule,
    origin: PRIVATE_CANONICAL_ORIGIN,
    root: "C:\\canonical",
  });
  await runPublicMirrorCommand("verify", {
    importModule,
    origin: PRIVATE_CANONICAL_ORIGIN,
    root: "C:\\canonical",
  });

  assert.equal(imports.length, 2);
  assert.match(imports[0], /\/sync-public\.mjs$/);
  assert.match(imports[1], /\/verify-public\.mjs$/);
});

test("public sync fails with the fixed canonical-only message before imports or root reads", async () => {
  let imported = false;
  await assert.rejects(
    runPublicMirrorCommand("sync", {
      importModule: async () => {
        imported = true;
        throw new Error("must not import");
      },
      origin: PUBLIC_MIRROR_ORIGIN,
      root: join(tmpdir(), "does-not-exist", "public"),
    }),
    (error) => {
      assert.equal(error.message, CANONICAL_SYNC_ONLY_MESSAGE);
      return true;
    },
  );
  assert.equal(imported, false);
});

test("public verify dispatches to the checkout-local self-verifier", async () => {
  const calls = [];
  const result = await runPublicMirrorCommand("verify", {
    importModule: async (specifier) => {
      calls.push(String(specifier));
      return {
        verifyPublicCheckout: async (root) => {
          calls.push(root);
          return { fileCount: 2 };
        },
      };
    },
    logger: { log: (message) => calls.push(message) },
    origin: PUBLIC_MIRROR_ORIGIN,
    root: "C:\\public",
  });

  assert.deepEqual(result, { fileCount: 2 });
  assert.match(calls[0], /\/lib\/public-mirror-self-verify\.mjs$/);
  assert.equal(calls[1], "C:\\public");
  assert.equal(calls[2], "Verified 2 public files with no blocked paths or secret signatures.");
});

test("unknown origins fail closed without loading an implementation", async () => {
  let imported = false;
  await assert.rejects(
    runPublicMirrorCommand("verify", {
      importModule: async () => {
        imported = true;
        return {};
      },
      origin: "git@github.com:someone-else/agency-workload.git",
      root: "C:\\unknown",
    }),
    (error) => {
      assert.equal(error.message, UNKNOWN_ORIGIN_MESSAGE);
      return true;
    },
  );
  assert.equal(imported, false);
});

test("public self-verification needs only a self-contained checkout", async (t) => {
  const { root } = await createValidPublicFixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  const result = await verifyPublicCheckout(root);
  assert.deepEqual(result, { fileCount: 2 });
});

test("sync omits local generated files without trusting them in the public tree", async () => {
  const file = {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };

  for (const name of ["build.log", "server.pid"]) {
    assert.equal(isSyncSourceIgnoredEntry(name, file), true);
    assert.equal(isPublicTreeIgnoredEntry(name, file), false);
  }
  assert.equal(isSyncSourceIgnoredEntry("tsconfig.tsbuildinfo", file), true);
  assert.equal(isPublicTreeIgnoredEntry("tsconfig.tsbuildinfo", file), true);

  const checkoutRoot = fileURLToPath(new URL("../..", import.meta.url));
  const origin = readExactOrigin(checkoutRoot);
  if (origin === PRIVATE_CANONICAL_ORIGIN) {
    const syncSource = await readFile(new URL("../sync-public.mjs", import.meta.url), "utf8");
    assert.match(syncSource, /isSyncSourceIgnoredEntry\(name, entry\)/);
  } else {
    assert.equal(origin, PUBLIC_MIRROR_ORIGIN);
    await assert.rejects(readFile(new URL("../sync-public.mjs", import.meta.url)), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
  }
});

test("public self-verification ignores only known generated entries at any depth", async (t) => {
  const { root } = await createValidPublicFixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  for (const path of [
    "apps/web/.next/server/app.js",
    "apps/web/.turbo/cache.json",
    "apps/web/.vite/deps/index.js",
    "apps/web/coverage/index.html",
    "apps/web/dist/assets/app.js",
    "apps/web/node_modules/generated-package/index.js",
    "apps/web/node_modules/generated-package/runtime.log",
    "apps/web/node_modules/generated-package/server.pid",
    "apps/web/playwright-report/index.html",
    "apps/web/test-results/results.json",
    "packages/domain/.git/config",
    "tmp/tsconfig.tsbuildinfo",
  ]) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split("/")), "generated\n", "utf8");
  }

  const result = await verifyPublicCheckout(root);
  assert.deepEqual(result, { fileCount: 2 });
});

test("public self-verification rejects managed and unmanaged logs and PID files", async (t) => {
  const { root } = await createValidPublicFixture({ "managed.log": "managed log\n" });
  t.after(() => rm(root, { force: true, recursive: true }));

  for (const path of ["runtime.log", "tmp/build.log", "tmp/server.pid"]) {
    await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(root, ...path.split("/")), "transient\n", "utf8");
  }

  await assert.rejects(verifyPublicCheckout(root), (error) => {
    assert.ok(error instanceof PublicMirrorVerificationError);
    for (const path of ["managed.log", "runtime.log", "tmp/build.log", "tmp/server.pid"]) {
      assert.ok(error.failures.includes(`Forbidden public extension: ${path}`));
    }
    return true;
  });
});

test("public self-verification rejects an unmanaged source file", async (t) => {
  const { root } = await createValidPublicFixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  await mkdir(join(root, "apps", "web", "src"), { recursive: true });
  await writeFile(join(root, "apps", "web", "src", "unmanaged.ts"), "export {};\n", "utf8");

  await assert.rejects(verifyPublicCheckout(root), (error) => {
    assert.ok(error instanceof PublicMirrorVerificationError);
    assert.ok(error.failures.includes("Unmanaged public file: apps/web/src/unmanaged.ts"));
    return true;
  });
});

test("generated-looking directory names cannot hide forbidden source or logs", async (t) => {
  const { root } = await createValidPublicFixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  const path = "apps/web/dist-cache/internal/note.md";
  await mkdir(join(root, ...path.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...path.split("/")), "private source\n", "utf8");
  const logPath = "apps/web/node_modules-cache/build.log";
  await mkdir(join(root, ...logPath.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...logPath.split("/")), "transient\n", "utf8");

  await assert.rejects(verifyPublicCheckout(root), (error) => {
    assert.ok(error instanceof PublicMirrorVerificationError);
    assert.ok(error.failures.includes(`Forbidden public path: ${path}`));
    assert.ok(error.failures.includes(`Forbidden public extension: ${logPath}`));
    return true;
  });
});

test("private verifier shares generated rules and remains private-only", async (t) => {
  const checkoutRoot = fileURLToPath(new URL("../..", import.meta.url));
  const origin = readExactOrigin(checkoutRoot);
  if (origin === PUBLIC_MIRROR_ORIGIN) {
    await assert.rejects(readFile(new URL("../verify-public.mjs", import.meta.url)), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
    return;
  }
  assert.equal(origin, PRIVATE_CANONICAL_ORIGIN);

  const fixtureRoot = await mkdtemp(join(tmpdir(), "agency-workload-private-verifier-"));
  const privateRoot = join(fixtureRoot, "private");
  const publicRoot = join(fixtureRoot, "public");
  t.after(() => rm(fixtureRoot, { force: true, recursive: true }));

  const privateFiles = {
    "tools/lib/config.mjs": await readFile(new URL("../lib/config.mjs", import.meta.url)),
    "tools/lib/public-generated-files.mjs": await readFile(
      new URL("../lib/public-generated-files.mjs", import.meta.url),
    ),
    "tools/verify-public.mjs": await readFile(new URL("../verify-public.mjs", import.meta.url)),
  };
  for (const [path, content] of Object.entries(privateFiles)) {
    await mkdir(join(privateRoot, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(privateRoot, ...path.split("/")), content);
  }
  const { manifest } = await createValidPublicFixture({}, publicRoot);

  for (const args of [
    ["init", "--quiet"],
    ["remote", "add", "origin", PUBLIC_MIRROR_ORIGIN],
  ]) {
    const git = spawnSync("git", args, { cwd: publicRoot, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }

  for (const path of [
    "apps/web/dist/assets/app.js",
    "apps/web/node_modules/generated-package/index.js",
    "apps/web/node_modules/generated-package/runtime.log",
    "apps/web/node_modules/generated-package/server.pid",
    "tmp/tsconfig.tsbuildinfo",
  ]) {
    await mkdir(join(publicRoot, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(publicRoot, ...path.split("/")), "generated\n", "utf8");
  }

  const verifierPath = join(privateRoot, "tools", "verify-public.mjs");
  const valid = spawnSync(process.execPath, [verifierPath], {
    cwd: privateRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /^Verified 2 public files/);

  await mkdir(join(publicRoot, "tmp"), { recursive: true });
  await writeFile(join(publicRoot, "tmp", "build.log"), "transient\n", "utf8");
  await writeFile(join(publicRoot, "worker.pid"), "1234\n", "utf8");
  const managedLog = "managed log\n";
  await writeFile(join(publicRoot, "managed.log"), managedLog, "utf8");
  manifest.files["managed.log"] = sha256(managedLog);
  await writeFile(
    join(publicRoot, ".mirror-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  const transient = spawnSync(process.execPath, [verifierPath], {
    cwd: privateRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(transient.status, 1);
  assert.match(transient.stderr, /Forbidden public extension: managed\.log/);
  assert.match(transient.stderr, /Forbidden public extension: tmp\/build\.log/);
  assert.match(transient.stderr, /Forbidden public extension: worker\.pid/);
  delete manifest.files["managed.log"];
  await writeFile(
    join(publicRoot, ".mirror-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  await rm(join(publicRoot, "managed.log"), { force: true });
  await rm(join(publicRoot, "tmp"), { force: true, recursive: true });
  await rm(join(publicRoot, "worker.pid"), { force: true });

  await mkdir(join(publicRoot, "apps", "web", "src"), { recursive: true });
  await writeFile(join(publicRoot, "apps", "web", "src", "unmanaged.ts"), "export {};\n", "utf8");
  const unmanaged = spawnSync(process.execPath, [verifierPath], {
    cwd: privateRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(unmanaged.status, 1);
  assert.match(unmanaged.stderr, /Unmanaged public file: apps\/web\/src\/unmanaged\.ts/);
});

test("temporary public-like checkout verifies after npm ci and refuses sync", async (t) => {
  const wrapper = await readFile(new URL("../public-mirror-command.mjs", import.meta.url));
  const selfVerifier = await readFile(
    new URL("../lib/public-mirror-self-verify.mjs", import.meta.url),
  );
  const generatedFiles = await readFile(
    new URL("../lib/public-generated-files.mjs", import.meta.url),
  );
  const { root } = await createValidPublicFixture({
    "package-lock.json": `${JSON.stringify(
      {
        name: "agency-workload-public-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "agency-workload-public-fixture",
            version: "1.0.0",
            workspaces: ["packages/tool"],
          },
          "node_modules/@fixture/tool": {
            resolved: "packages/tool",
            link: true,
          },
          "packages/tool": {
            name: "@fixture/tool",
            version: "1.0.0",
          },
        },
      },
      null,
      2,
    )}\n`,
    "package.json": `${JSON.stringify(
      {
        name: "agency-workload-public-fixture",
        version: "1.0.0",
        private: true,
        workspaces: ["packages/tool"],
      },
      null,
      2,
    )}\n`,
    "packages/tool/package.json": `${JSON.stringify(
      {
        name: "@fixture/tool",
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
    "tools/lib/public-generated-files.mjs": generatedFiles,
    "tools/lib/public-mirror-self-verify.mjs": selfVerifier,
    "tools/public-mirror-command.mjs": wrapper,
  });
  t.after(() => rm(root, { force: true, recursive: true }));

  for (const args of [
    ["init", "--quiet"],
    ["remote", "add", "origin", PUBLIC_MIRROR_ORIGIN],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }

  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const install = spawnSync(
    process.execPath,
    [npmCli, "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
    },
  );
  assert.equal(install.status, 0, install.stderr || install.error?.message || "npm ci failed");

  const verify = spawnSync(process.execPath, ["tools/public-mirror-command.mjs", "verify"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /^Verified 8 public files/);

  const sync = spawnSync(process.execPath, ["tools/public-mirror-command.mjs", "sync"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(sync.status, 1);
  assert.equal(sync.stderr.trim(), CANONICAL_SYNC_ONLY_MESSAGE);

  for (const privateOnlyPath of ["public-files.json", "sync-public.mjs", "verify-public.mjs"]) {
    await assert.rejects(readFile(join(root, "tools", privateOnlyPath)), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
  }
});

test("public self-verification reports hash, inventory, path, extension, symlink, and secret failures", async (t) => {
  const { manifest, root } = await createValidPublicFixture();
  t.after(() => rm(root, { force: true, recursive: true }));

  await writeFile(join(root, "README.md"), "changed\n", "utf8");
  await writeFile(join(root, "unmanaged.txt"), "extra\n", "utf8");
  await mkdir(join(root, "internal"), { recursive: true });
  await writeFile(join(root, "internal", "note.md"), "private path\n", "utf8");
  await writeFile(join(root, "backup.sql"), "select 1;\n", "utf8");
  const secretContent = `token=ghp_${"A".repeat(24)}\n`;
  await writeFile(join(root, "secret.txt"), secretContent, "utf8");
  await mkdir(join(root, "safe-directory"), { recursive: true });
  await symlink(
    join(root, "safe-directory"),
    join(root, "linked-directory"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await symlink(
    join(root, "safe-directory"),
    join(root, "dist"),
    process.platform === "win32" ? "junction" : "dir",
  );

  manifest.files["missing.txt"] = sha256("missing\n");
  manifest.files["internal/note.md"] = sha256("private path\n");
  manifest.files["backup.sql"] = sha256("select 1;\n");
  manifest.files["secret.txt"] = sha256(secretContent);
  await writeFile(
    join(root, ".mirror-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  await assert.rejects(verifyPublicCheckout(root), (error) => {
    assert.ok(error instanceof PublicMirrorVerificationError);
    assert.ok(
      error.failures.some((failure) => failure === "Public file changed after sync: README.md"),
    );
    assert.ok(error.failures.some((failure) => failure === "Unmanaged public file: unmanaged.txt"));
    assert.ok(
      error.failures.some((failure) => failure === "Missing synchronized public file: missing.txt"),
    );
    assert.ok(
      error.failures.some((failure) => failure === "Forbidden public path: internal/note.md"),
    );
    assert.ok(
      error.failures.some((failure) => failure === "Forbidden public extension: backup.sql"),
    );
    assert.ok(
      error.failures.some(
        (failure) => failure === "Symlink is not allowed publicly: linked-directory",
      ),
    );
    assert.ok(
      error.failures.some((failure) => failure === "Symlink is not allowed publicly: dist"),
    );
    assert.ok(
      error.failures.some(
        (failure) => failure === "Secret-like content in public file: secret.txt",
      ),
    );
    return true;
  });
});

test("overlapping includes produce a unique sorted manifest inventory and count", () => {
  const emittedFiles = uniqueSortedPaths([
    "tools/lib/config.mjs",
    "tools/lib/redact.mjs",
    "tools/lib/config.mjs",
    "README.md",
  ]);
  const manifestFiles = Object.fromEntries(emittedFiles.map((path) => [path, "hash"]));

  assert.deepEqual(emittedFiles, ["README.md", "tools/lib/config.mjs", "tools/lib/redact.mjs"]);
  assert.equal(emittedFiles.length, Object.keys(manifestFiles).length);
});
