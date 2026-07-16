import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { isSyncSourceIgnoredEntry } from "../lib/public-generated-files.mjs";
import { verifyPublicCheckout } from "../lib/public-mirror-self-verify.mjs";
import {
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
} from "../public-mirror-command.mjs";
import { PresentationVerificationError, verifyReadmePresentation } from "../verify-readme.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
function classifyCheckoutOrigin(origin) {
  if (origin === PRIVATE_CANONICAL_ORIGIN) return "private";
  if (origin === PUBLIC_MIRROR_ORIGIN) return "public";
  throw new Error("README presentation tests require the exact canonical or public origin.");
}

let checkoutOrigin;
let checkoutMode;
let checkoutOriginError;
try {
  checkoutOrigin = readExactOrigin(projectRoot);
  checkoutMode = classifyCheckoutOrigin(checkoutOrigin);
} catch (error) {
  checkoutOriginError = error;
}
const canonicalTestOptions =
  checkoutMode === "private"
    ? {}
    : { skip: "This assertion requires the exact private canonical origin." };
const publicTestOptions =
  checkoutMode === "public" ? {} : { skip: "This assertion requires the exact public origin." };
const sourceAsset = join(projectRoot, "docs", "assets", "readme-cover.webp");
const sourceProvenance = join(projectRoot, "internal", "readme-art-provenance.md");
const sourceExpectedRecord = join(projectRoot, "internal", "readme-art-provenance.expected.json");
const validReadme = await readFile(join(projectRoot, "README.md"), "utf8");
const requiredPublicPresentationPaths = [
  "docs/assets/readme-cover.webp",
  "tools/test/verify-readme.test.mjs",
  "tools/verify-readme.mjs",
];

async function createFixture(t, { expectedRecord = false, provenance = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agency-workload-readme-"));
  t.after(() => rm(root, { force: true, recursive: true }));

  await mkdir(join(root, "docs", "assets"), { recursive: true });
  await writeFile(join(root, "README.md"), validReadme, "utf8");
  await copyFile(sourceAsset, join(root, "docs", "assets", "readme-cover.webp"));

  if (provenance || expectedRecord) {
    await mkdir(join(root, "internal"), { recursive: true });
  }
  if (provenance) {
    await copyFile(sourceProvenance, join(root, "internal", "readme-art-provenance.md"));
  }
  if (expectedRecord) {
    await copyFile(
      sourceExpectedRecord,
      join(root, "internal", "readme-art-provenance.expected.json"),
    );
  }

  return root;
}

async function writeFixtureReadme(root, transform) {
  await writeFile(join(root, "README.md"), transform(validReadme), "utf8");
}

async function expectFailure(root, origin, expected) {
  await assert.rejects(verifyReadmePresentation(root, { origin }), (error) => {
    assert.ok(error instanceof PresentationVerificationError);
    assert.ok(
      error.failures.some((failure) => expected.test(failure)),
      `Expected ${expected}, received: ${error.failures.join(" | ")}`,
    );
    return true;
  });
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function createChunk(type, payload) {
  assert.equal(type.length, 4);
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, Buffer.alloc(payload.length % 2)]);
}

function createWebp(chunks) {
  const body = Buffer.concat(chunks.map(([type, payload]) => createChunk(type, payload)));
  const header = Buffer.alloc(12);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length + 4, 4);
  header.write("WEBP", 8, "ascii");
  return Buffer.concat([header, body]);
}

function createVp8xPayload(width, height, flags = 0) {
  const payload = Buffer.alloc(10);
  payload[0] = flags;
  payload.writeUIntLE(width - 1, 4, 3);
  payload.writeUIntLE(height - 1, 7, 3);
  return payload;
}

function createVp8Payload(width, height, { validSignature = true } = {}) {
  const payload = Buffer.alloc(10);
  payload[0] = 0x10;
  if (validSignature) payload.set([0x9d, 0x01, 0x2a], 3);
  payload.writeUInt16LE(width, 6);
  payload.writeUInt16LE(height, 8);
  return payload;
}

function createVp8lPayload(width, height, version = 0) {
  const payload = Buffer.alloc(5);
  const packed = (width - 1) | ((height - 1) << 14) | (version << 29);
  payload[0] = 0x2f;
  payload.writeUInt32LE(packed >>> 0, 1);
  return payload;
}

function removeProvenanceField(content, field) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(new RegExp(`^\\*\\*${escapedField}:\\*\\* .+\\n?`, "m"), "");
}

function removeProvenanceSection(content, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.replace(
    new RegExp(`^## ${escapedHeading}\\n\\n[\\s\\S]*?(?=\\n\\n## |$)`, "m"),
    "",
  );
}

function provenanceFieldValue(content, field) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\*\\*${escapedField}:\\*\\* (.+)$`, "m").exec(content)?.[1];
}

function provenanceSectionValue(content, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## ${escapedHeading}\\n\\n([\\s\\S]*?)(?=\\n\\n## |$)`, "m").exec(
    content,
  )?.[1];
}

async function copyPublicEntry(root, repositoryPath, hashes) {
  const source = join(projectRoot, ...repositoryPath.split("/"));
  const destination = join(root, ...repositoryPath.split("/"));
  const entry = await lstat(source);
  const name = basename(source);
  if (entry.isSymbolicLink())
    throw new Error(`Public-like copy rejects symlink: ${repositoryPath}`);
  if (isSyncSourceIgnoredEntry(name, entry)) return;
  if (/^\.env(?:\.|$)/.test(name) && !name.endsWith(".example")) return;

  if (entry.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const child of (await readdir(source)).sort()) {
      await copyPublicEntry(root, `${repositoryPath}/${child}`, hashes);
    }
    return;
  }

  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  hashes.set(repositoryPath, sha256(await readFile(destination)));
}

async function createPublicLikeCheckout(t) {
  const root = await mkdtemp(join(dirname(projectRoot), "public-presentation-test-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  const config = JSON.parse(
    await readFile(join(projectRoot, "tools", "public-files.json"), "utf8"),
  );
  const hashes = new Map();
  for (const repositoryPath of config.include) {
    await copyPublicEntry(root, repositoryPath, hashes);
  }
  const files = Object.fromEntries(
    [...hashes].sort(([left], [right]) => left.localeCompare(right)),
  );
  await writeFile(
    join(root, ".mirror-manifest.json"),
    `${JSON.stringify(
      { files, generatedBy: "tools/sync-public.mjs", version: config.version },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const args of [
    ["init", "--quiet"],
    ["remote", "add", "origin", PUBLIC_MIRROR_ORIGIN],
  ]) {
    const git = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  return root;
}

function truncateRealImagePayload(content) {
  const chunks = [];
  let foundImagePayload = false;
  let offset = 12;
  while (offset < content.length) {
    const type = content.toString("ascii", offset, offset + 4);
    const size = content.readUInt32LE(offset + 4);
    const dataOffset = offset + 8;
    let payload = Buffer.from(content.subarray(dataOffset, dataOffset + size));
    if (type === "VP8 " || type === "VP8L") {
      const minimum = type === "VP8 " ? 10 : 5;
      payload = payload.subarray(0, Math.max(minimum, Math.floor(payload.length / 4)));
      foundImagePayload = true;
    }
    chunks.push([type, payload]);
    offset = dataOffset + size + (size % 2);
  }
  assert.equal(foundImagePayload, true);
  return createWebp(chunks);
}

function runNpm(root, args, timeout) {
  const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", `npm ${args.join(" ")}`] : args;
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    env: environment,
    timeout,
    windowsHide: true,
  });
}

function commandFailure(result) {
  return (
    result.error?.message ?? result.stderr ?? result.stdout ?? "Command failed without output."
  );
}

test("origin classification recognizes the exact private origin", () => {
  assert.equal(classifyCheckoutOrigin(PRIVATE_CANONICAL_ORIGIN), "private");
});

test("origin classification recognizes the exact public origin", () => {
  assert.equal(classifyCheckoutOrigin(PUBLIC_MIRROR_ORIGIN), "public");
});

test("origin classification rejects unknown and missing origins", () => {
  for (const origin of [
    undefined,
    "",
    "https://github.com/ai-gen-codes/agency-workload.git",
    "git@github.com:someone-else/agency-workload.git",
  ]) {
    assert.throws(() => classifyCheckoutOrigin(origin), /exact canonical or public origin/i);
  }
});

test("the current checkout has a recognized exact origin", () => {
  assert.equal(
    checkoutOriginError,
    undefined,
    checkoutOriginError instanceof Error
      ? checkoutOriginError.message
      : String(checkoutOriginError),
  );
  assert.ok(checkoutMode === "private" || checkoutMode === "public");
});

test("package wiring and presentation inventory are safe for the exact checkout origin", async () => {
  const packageJson = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(projectRoot, "package-lock.json"), "utf8"));
  const presentationIndex = packageJson.scripts.verify.indexOf("npm run verify:presentation");
  const testIndex = packageJson.scripts.verify.indexOf("npm run test");
  const buildIndex = packageJson.scripts.verify.indexOf("npm run build");

  assert.equal(packageJson.scripts["verify:presentation"], "node tools/verify-readme.mjs");
  assert.equal(packageJson.devDependencies.sharp, "0.35.3");
  assert.equal(packageLock.packages[""].devDependencies.sharp, "0.35.3");
  assert.equal(packageLock.packages["node_modules/sharp"].version, "0.35.3");
  assert.ok(presentationIndex >= 0, "verify script is missing the presentation gate");
  assert.ok(testIndex >= 0, "verify script is missing the test gate");
  assert.ok(buildIndex >= 0, "verify script is missing the build gate");
  assert.ok(presentationIndex < testIndex);
  assert.ok(presentationIndex < buildIndex);
  assert.match(packageJson.scripts["test:tools"], /tools\/test\/verify-readme\.test\.mjs/);

  if (checkoutMode === "private") {
    const allowlist = JSON.parse(
      await readFile(join(projectRoot, "tools", "public-files.json"), "utf8"),
    ).include;
    assert.ok(allowlist.includes("tools/verify-readme.mjs"));
    assert.ok(allowlist.includes("tools/test/verify-readme.test.mjs"));
    assert.equal(
      allowlist.some((path) => path === "internal" || path.startsWith("internal/")),
      false,
    );
    return;
  }

  if (checkoutMode === "public") {
    await assert.rejects(readFile(join(projectRoot, "tools", "public-files.json")), (error) => {
      assert.equal(error.code, "ENOENT");
      return true;
    });
    const manifest = JSON.parse(await readFile(join(projectRoot, ".mirror-manifest.json"), "utf8"));
    const result = await verifyPublicCheckout(projectRoot);
    assert.equal(result.fileCount, Object.keys(manifest.files).length);
    for (const repositoryPath of requiredPublicPresentationPaths) {
      assert.match(manifest.files[repositoryPath], /^[a-f0-9]{64}$/);
      assert.equal((await lstat(join(projectRoot, ...repositoryPath.split("/")))).isFile(), true);
    }
    return;
  }
});

test(
  "exact public mode verifies only manifest-managed public files",
  publicTestOptions,
  async () => {
    const manifest = JSON.parse(await readFile(join(projectRoot, ".mirror-manifest.json"), "utf8"));
    assert.equal(
      Object.keys(manifest.files).some((path) => path.split("/").includes("internal")),
      false,
    );
    const result = await verifyPublicCheckout(projectRoot);
    assert.equal(result.fileCount, Object.keys(manifest.files).length);
  },
);

test(
  "the canonical checkout passes with matching private provenance",
  canonicalTestOptions,
  async () => {
    const expectedRecord = JSON.parse(await readFile(sourceExpectedRecord, "utf8"));
    const result = await verifyReadmePresentation(projectRoot, {
      origin: PRIVATE_CANONICAL_ORIGIN,
    });

    assert.deepEqual(result, {
      bytes: expectedRecord.asset.bytes,
      height: 900,
      provenance: "verified",
      sha256: expectedRecord.asset.sha256,
      width: 1600,
    });
  },
);

test(
  "allowlisted verifier and tests contain no exact private provenance values",
  canonicalTestOptions,
  async () => {
    const [provenance, expectedRecordContent, verifier, testSource] = await Promise.all([
      readFile(sourceProvenance, "utf8"),
      readFile(sourceExpectedRecord, "utf8"),
      readFile(join(projectRoot, "tools", "verify-readme.mjs"), "utf8"),
      readFile(fileURLToPath(import.meta.url), "utf8"),
    ]);
    const expectedRecord = JSON.parse(expectedRecordContent);
    const privateValues = new Set([
      provenanceFieldValue(provenance, "Generated"),
      provenanceFieldValue(provenance, "Source/reference assets"),
      provenanceFieldValue(provenance, "Rights"),
      provenanceFieldValue(provenance, "Model"),
      provenanceSectionValue(provenance, "Final Prompt"),
      provenanceSectionValue(provenance, "Processing")?.trim(),
      expectedRecord.generatedDate,
      String(expectedRecord.asset.bytes),
      expectedRecord.asset.sha256,
    ]);

    for (const privateValue of privateValues) {
      assert.ok(privateValue);
      assert.equal(verifier.includes(privateValue), false);
      assert.equal(testSource.includes(privateValue), false);
    }
  },
);

test(
  "canonical provenance declares no source assets and appropriate generated-art rights",
  canonicalTestOptions,
  async () => {
    const provenance = await readFile(sourceProvenance, "utf8");
    const sourceReference = provenanceFieldValue(provenance, "Source/reference assets");
    const rights = provenanceFieldValue(provenance, "Rights");
    const model = provenanceFieldValue(provenance, "Model");
    assert.ok(sourceReference);
    assert.ok(rights);
    assert.ok(model);
    assert.match(sourceReference, /^none(?:\b|[;,.])/i);
    assert.doesNotMatch(sourceReference, /https?:\/\//i);
    assert.doesNotMatch(sourceReference, /(?:\.\.?[/\\]|[a-z]:\\)/i);
    const provider = model.replace(/`[^`]+`/g, "").trim();
    assert.ok(provider.length >= 3);
    assert.ok(rights.includes(provider));
    assert.match(rights, /\buse\b/i);
    assert.match(rights, /\bmodify\b/i);
    assert.match(rights, /\bdistribut(?:e|ion)\b/i);
    assert.doesNotMatch(rights, /https?:\/\//i);
  },
);

test(
  "a copied public-like checkout passes presentation tests without private files",
  canonicalTestOptions,
  async (t) => {
    const root = await createPublicLikeCheckout(t);
    const install = runNpm(root, ["ci"], 180_000);
    assert.equal(install.status, 0, commandFailure(install));
    const presentation = runNpm(root, ["run", "verify:presentation"], 120_000);
    assert.equal(presentation.status, 0, commandFailure(presentation));
    const publicVerification = runNpm(root, ["run", "public:verify"], 120_000);
    assert.equal(publicVerification.status, 0, commandFailure(publicVerification));
    const fullVerification = runNpm(root, ["run", "verify"], 420_000);
    assert.equal(fullVerification.status, 0, commandFailure(fullVerification));
  },
);

test("a public checkout passes using only its README and asset", async (t) => {
  const root = await createFixture(t);
  const result = await verifyReadmePresentation(root, { origin: PUBLIC_MIRROR_ORIGIN });

  assert.equal(result.provenance, "not-required");
  assert.equal(result.width, 1600);
  assert.equal(result.height, 900);
});

test("origin detection fails closed for every non-exact origin", async (t) => {
  const root = await createFixture(t);

  for (const origin of [
    "https://github.com/ai-gen-codes/agency-workload.git",
    "git@github.com:BrainAI-space/agency-workload",
    "git@github.com:someone-else/agency-workload.git",
  ]) {
    await expectFailure(root, origin, /exact private canonical or public mirror origin/);
  }
});

test("the canonical checkout requires private provenance", canonicalTestOptions, async (t) => {
  const root = await createFixture(t);
  await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, /provenance.*missing/i);
});

test(
  "canonical validation requires a strict independently bound expected record",
  canonicalTestOptions,
  async (t) => {
    await t.test("missing record", async (t) => {
      const root = await createFixture(t, { provenance: true });
      await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, /expected record.*missing/i);
    });

    await t.test("malformed JSON", async (t) => {
      const root = await createFixture(t, { provenance: true });
      await writeFile(join(root, "internal", "readme-art-provenance.expected.json"), "{", "utf8");
      await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, /expected record.*valid JSON/i);
    });

    await t.test("malformed schema", async (t) => {
      const root = await createFixture(t, { provenance: true });
      await writeFile(
        join(root, "internal", "readme-art-provenance.expected.json"),
        `${JSON.stringify({ asset: {}, generatedDate: "invalid", version: 1, extra: true })}\n`,
        "utf8",
      );
      await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, /expected record.*strict schema/i);
    });

    for (const [name, mutate, expected] of [
      [
        "generated date mismatch",
        (record) => {
          const changed = new Date(`${record.generatedDate}T00:00:00.000Z`);
          changed.setUTCDate(changed.getUTCDate() + 1);
          record.generatedDate = changed.toISOString().slice(0, 10);
        },
        /Generated date.*expected record/i,
      ],
      [
        "asset byte mismatch",
        (record) => {
          record.asset.bytes += 1;
        },
        /expected record.*bytes.*asset/i,
      ],
      [
        "asset hash mismatch",
        (record) => {
          const first = record.asset.sha256[0] === "0" ? "1" : "0";
          record.asset.sha256 = `${first}${record.asset.sha256.slice(1)}`;
        },
        /expected record.*SHA-256.*asset/i,
      ],
    ]) {
      await t.test(name, async (t) => {
        const root = await createFixture(t, { expectedRecord: true, provenance: true });
        const path = join(root, "internal", "readme-art-provenance.expected.json");
        const record = JSON.parse(await readFile(path, "utf8"));
        mutate(record);
        await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
        await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, expected);
      });
    }
  },
);

test("README opening rejects missing content, incorrect order, links, paths, and alt text", async (t) => {
  const cases = [
    ["leading content", (text) => `Intro\n\n${text}`, /title must be the first line/i],
    [
      "HTTP agency link",
      (text) => text.replace("https://brainai.team", "http://brainai.team"),
      /approved BrainAI Team blockquote/i,
    ],
    [
      "missing hire-us link",
      (text) => text.replace("https://brainai.team/hire-us", "https://brainai.team"),
      /approved BrainAI Team blockquote/i,
    ],
    [
      "image after description",
      (text) => {
        const lines = text.split("\n");
        [lines[4], lines[6]] = [lines[6], lines[4]];
        return lines.join("\n");
      },
      /cover image must immediately follow/i,
    ],
    [
      "empty alt",
      (text) =>
        text.replace(
          /!\[[^\]]+\]\(docs\/assets\/readme-cover\.webp\)/,
          "![](docs/assets/readme-cover.webp)",
        ),
      /alt text/i,
    ],
    [
      "generic alt",
      (text) =>
        text.replace(
          /!\[[^\]]+\]\(docs\/assets\/readme-cover\.webp\)/,
          "![Cover image](docs/assets/readme-cover.webp)",
        ),
      /approved descriptive alt text/i,
    ],
    [
      "inaccurate alt",
      (text) =>
        text.replace(
          /!\[[^\]]+\]\(docs\/assets\/readme-cover\.webp\)/,
          "![A colorful abstract technology dashboard](docs/assets/readme-cover.webp)",
        ),
      /approved descriptive alt text/i,
    ],
    [
      "private image path",
      (text) => text.replace("docs/assets/readme-cover.webp", "internal/readme-cover.webp"),
      /private or internal path/i,
    ],
    [
      "placeholder filename",
      (text) => text.replace("readme-cover.webp", "placeholder.webp"),
      /placeholder filename/i,
    ],
    [
      "missing product description",
      (text) =>
        text.replace(
          "Open-source resource and capacity planning for agencies and service teams.\n\n",
          "",
        ),
      /one-sentence product description/i,
    ],
    [
      "two-sentence product description",
      (text) =>
        text.replace(
          "Open-source resource and capacity planning for agencies and service teams.",
          "Open-source resource and capacity planning for agencies and service teams. Another sentence.",
        ),
      /one-sentence product description/i,
    ],
  ];

  for (const [name, transform, expected] of cases) {
    await t.test(name, async (t) => {
      const root = await createFixture(t);
      await writeFixtureReadme(root, transform);
      await expectFailure(root, PUBLIC_MIRROR_ORIGIN, expected);
    });
  }
});

test("asset resolution is case-sensitive even on a case-insensitive filesystem", async (t) => {
  const root = await createFixture(t);
  const asset = join(root, "docs", "assets", "readme-cover.webp");
  const intermediate = join(root, "docs", "assets", "case-change.tmp");
  await rename(asset, intermediate);
  await rename(intermediate, join(root, "docs", "assets", "README-COVER.WEBP"));

  await expectFailure(root, PUBLIC_MIRROR_ORIGIN, /case does not match/i);
});

test("full decode accepts the real asset and rejects structurally plausible fake data", async (t) => {
  await t.test("valid real artwork", async (t) => {
    const root = await createFixture(t);
    const result = await verifyReadmePresentation(root, { origin: PUBLIC_MIRROR_ORIGIN });
    assert.equal(result.width, 1600);
    assert.equal(result.height, 900);
  });

  await t.test("header-only VP8 payload", async (t) => {
    const root = await createFixture(t);
    const content = createWebp([
      ["VP8X", createVp8xPayload(1600, 900)],
      ["VP8 ", createVp8Payload(1600, 900)],
    ]);
    await writeFile(join(root, "docs", "assets", "readme-cover.webp"), content);
    await expectFailure(root, PUBLIC_MIRROR_ORIGIN, /fully decode without warnings or errors/i);
  });

  await t.test("truncated compressed payload with repaired RIFF lengths", async (t) => {
    const root = await createFixture(t);
    const content = truncateRealImagePayload(await readFile(sourceAsset));
    await writeFile(join(root, "docs", "assets", "readme-cover.webp"), content);
    await expectFailure(root, PUBLIC_MIRROR_ORIGIN, /fully decode without warnings or errors/i);
  });
});

test("WebP validation rejects incomplete, forged, animated, and conflicting structures", async (t) => {
  const cases = [
    [
      "VP8X header without image payload",
      () => createWebp([["VP8X", createVp8xPayload(1600, 900)]]),
      /real VP8 or VP8L image payload/i,
    ],
    [
      "truncated chunk",
      () => {
        const content = createWebp([["VP8 ", createVp8Payload(1600, 900)]]);
        content.writeUInt32LE(1000, 16);
        return content;
      },
      /truncated WebP chunk/i,
    ],
    [
      "forged RIFF length",
      () => {
        const content = createWebp([["VP8 ", createVp8Payload(1600, 900)]]);
        content.writeUInt32LE(content.length - 9, 4);
        return content;
      },
      /RIFF length.*asset byte length/i,
    ],
    [
      "invalid VP8 signature",
      () => createWebp([["VP8 ", createVp8Payload(1600, 900, { validSignature: false })]]),
      /invalid VP8 frame signature/i,
    ],
    [
      "trailing bytes inside declared RIFF",
      () => {
        const content = Buffer.concat([
          createWebp([["VP8 ", createVp8Payload(1600, 900)]]),
          Buffer.from([0, 0]),
        ]);
        content.writeUInt32LE(content.length - 8, 4);
        return content;
      },
      /traversal must end exactly at the RIFF file end/i,
    ],
    [
      "animation flag",
      () =>
        createWebp([
          ["VP8X", createVp8xPayload(1600, 900, 0x02)],
          ["VP8 ", createVp8Payload(1600, 900)],
        ]),
      /animation/i,
    ],
    [
      "ANMF frame",
      () =>
        createWebp([
          ["VP8X", createVp8xPayload(1600, 900)],
          ["ANMF", Buffer.alloc(16)],
          ["VP8 ", createVp8Payload(1600, 900)],
        ]),
      /animation/i,
    ],
    [
      "multiple image payloads",
      () =>
        createWebp([
          ["VP8 ", createVp8Payload(1600, 900)],
          ["VP8L", createVp8lPayload(1600, 900)],
        ]),
      /exactly one VP8 or VP8L image payload/i,
    ],
    [
      "VP8X canvas disagrees with payload",
      () =>
        createWebp([
          ["VP8X", createVp8xPayload(1600, 900)],
          ["VP8 ", createVp8Payload(1599, 900)],
        ]),
      /VP8X canvas.*image payload/i,
    ],
    [
      "unsupported VP8L version",
      () => createWebp([["VP8L", createVp8lPayload(1600, 900, 1)]]),
      /VP8L version/i,
    ],
    [
      "missing odd-chunk padding",
      () => {
        const junkHeader = Buffer.alloc(8);
        junkHeader.write("JUNK", 0, "ascii");
        junkHeader.writeUInt32LE(1, 4);
        const body = Buffer.concat([
          junkHeader,
          Buffer.from([1]),
          createChunk("VP8 ", createVp8Payload(1600, 900)),
        ]);
        const header = Buffer.alloc(12);
        header.write("RIFF", 0, "ascii");
        header.writeUInt32LE(body.length + 4, 4);
        header.write("WEBP", 8, "ascii");
        return Buffer.concat([header, body]);
      },
      /padding/i,
    ],
  ];

  for (const [name, createContent, expected] of cases) {
    await t.test(name, async (t) => {
      const root = await createFixture(t);
      await writeFile(join(root, "docs", "assets", "readme-cover.webp"), createContent());
      await expectFailure(root, PUBLIC_MIRROR_ORIGIN, expected);
    });
  }
});

test("asset validation rejects source siblings, bad WebP data, dimensions, and byte limits", async (t) => {
  const cases = [
    [
      "source PNG sibling",
      async (root) =>
        writeFile(join(root, "docs", "assets", "readme-cover.png"), Buffer.from("source")),
      /source PNG\/JPEG sibling/i,
    ],
    [
      "source JPEG sibling",
      async (root) =>
        writeFile(join(root, "docs", "assets", "readme-cover.JPG"), Buffer.from("source")),
      /source PNG\/JPEG sibling/i,
    ],
    [
      "bad WebP signature",
      async (root) => {
        const path = join(root, "docs", "assets", "readme-cover.webp");
        const content = await readFile(path);
        content.write("NOPE", 0, "ascii");
        await writeFile(path, content);
      },
      /valid WebP RIFF signature/i,
    ],
    [
      "wrong dimensions",
      async (root) =>
        writeFile(
          join(root, "docs", "assets", "readme-cover.webp"),
          createWebp([["VP8 ", createVp8Payload(1599, 900)]]),
        ),
      /exactly 1600x900/i,
    ],
    [
      "oversized asset",
      async (root) => {
        const content = Buffer.alloc(500 * 1024 + 1);
        content.write("RIFF", 0, "ascii");
        content.write("WEBP", 8, "ascii");
        await writeFile(join(root, "docs", "assets", "readme-cover.webp"), content);
      },
      /500 KiB or smaller/i,
    ],
  ];

  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (t) => {
      const root = await createFixture(t);
      await mutate(root);
      await expectFailure(root, PUBLIC_MIRROR_ORIGIN, expected);
    });
  }
});

test(
  "canonical provenance requires every identity, rights, and generation field",
  canonicalTestOptions,
  async (t) => {
    const cases = [
      [
        "generated date",
        (text) => removeProvenanceField(text, "Generated"),
        /Generated date.*YYYY-MM-DD/i,
      ],
      [
        "source/reference assets",
        (text) => removeProvenanceField(text, "Source/reference assets"),
        /Source\/reference assets/i,
      ],
      ["rights", (text) => removeProvenanceField(text, "Rights"), /Rights.*provenance/i],
      [
        "published bytes",
        (text) => removeProvenanceField(text, "Published bytes"),
        /Published bytes.*asset/i,
      ],
      ["SHA-256", (text) => removeProvenanceField(text, "SHA-256"), /SHA-256.*asset/i],
      [
        "model",
        (text) => removeProvenanceField(text, "Model"),
        /Model.*approved asset provenance/i,
      ],
      [
        "prompt",
        (text) => removeProvenanceSection(text, "Final Prompt"),
        /Final Prompt.*approved asset provenance/i,
      ],
      [
        "processing",
        (text) => removeProvenanceSection(text, "Processing"),
        /Processing.*approved asset provenance/i,
      ],
      [
        "published path",
        (text) => text.replace("docs/assets/readme-cover.webp", "docs/assets/other.webp"),
        /Published asset.*README image path/i,
      ],
      ["SHA-256", (text) => text.replace(/[a-f0-9]{64}/, "0".repeat(64)), /SHA-256.*asset/i],
      [
        "invalid generated date",
        (text) => text.replace(/^\*\*Generated:\*\* .+$/m, "**Generated:** invalid-date"),
        /YYYY-MM-DD/i,
      ],
      [
        "incorrect model",
        (text) => text.replace(/^\*\*Model:\*\* .+$/m, "**Model:** Unknown model"),
        /Model.*approved asset provenance/i,
      ],
      [
        "incorrect prompt",
        (text) =>
          text.replace(
            /^(## Final Prompt\n\n)[\s\S]*?(?=\n\n## Processing)/m,
            "$1> Unrelated prompt",
          ),
        /Final Prompt.*approved asset provenance/i,
      ],
      [
        "incorrect processing",
        (text) => text.replace(/^(## Processing\n\n)[\s\S]*$/m, "$1Unknown processing."),
        /Processing.*approved asset provenance/i,
      ],
    ];

    for (const [name, transform, expected] of cases) {
      await t.test(name, async (t) => {
        const root = await createFixture(t, { expectedRecord: true, provenance: true });
        const path = join(root, "internal", "readme-art-provenance.md");
        await writeFile(path, transform(await readFile(path, "utf8")), "utf8");
        await expectFailure(root, PRIVATE_CANONICAL_ORIGIN, expected);
      });
    }
  },
);
