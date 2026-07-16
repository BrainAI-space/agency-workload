import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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

async function createValidPublicFixture(extraFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), "agency-workload-public-"));
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

  await mkdir(join(root, "node_modules", "generated-package"), { recursive: true });
  await writeFile(join(root, "node_modules", "generated-package", "index.js"), "generated\n");
  await mkdir(join(root, "apps", "web"), { recursive: true });
  await writeFile(join(root, "apps", "web", "tsconfig.tsbuildinfo"), "generated\n");

  const result = await verifyPublicCheckout(root);
  assert.deepEqual(result, { fileCount: 2 });
});

test("temporary public-like checkout verifies and refuses sync without private files", async (t) => {
  const wrapper = await readFile(new URL("../public-mirror-command.mjs", import.meta.url));
  const selfVerifier = await readFile(
    new URL("../lib/public-mirror-self-verify.mjs", import.meta.url),
  );
  const { root } = await createValidPublicFixture({
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

  const verify = spawnSync(process.execPath, ["tools/public-mirror-command.mjs", "verify"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /^Verified 4 public files/);

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
