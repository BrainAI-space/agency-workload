import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";

import {
  PRIVATE_CANONICAL_ORIGIN,
  PUBLIC_MIRROR_ORIGIN,
  readExactOrigin,
} from "./public-mirror-command.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readmePath = "README.md";
const assetPath = "docs/assets/readme-cover.webp";
const provenancePath = "internal/readme-art-provenance.md";
const expectedRecordPath = "internal/readme-art-provenance.expected.json";
const maxAssetBytes = 500 * 1024;
const expectedWidth = 1600;
const expectedHeight = 900;
const maxDecodedPixels = expectedWidth * expectedHeight;
const minDecodedChannels = 3;
const maxDecodedChannels = 4;
const expectedTitle = "# Agency Workload";
const approvedBlockquote =
  "> **Built by [BrainAI Team](https://brainai.team).** We build agentic teams and practical AI automations for growing businesses. Need this customized, integrated, hosted, or expanded for your workflow? [Work with us](https://brainai.team/hire-us).";
const approvedAltText =
  "Abstract editorial collage of measured paper strips, load-bearing blocks, and deliberate gaps arranged like a planning ledger";
const productDescription =
  "Open-source resource and capacity planning for agencies and service teams.";
const provenanceFingerprints = {
  model: "6433e527ae384203b98267cd440beb5d2667ba930f5fc9338d9316fce63e40fb",
  processing: "a6df837d62602e6284b09e05ae244050543c75a7b494499b48a1407f2eb8d416",
  prompt: "8edad5de58060c71005937ae144ee5d8513cafad3387845885ca15a99c14e52b",
  rights: "eb0bd54fa44a9c233648bb6ea7961a4aa78527439beb74f448b2d39a69331332",
  sourceReference: "2fc809ed7ac5fdd3504efc179dcbad2562372f3f1cdaa9c8fa5c3d63ce620ffd",
};
const genericAltTexts = new Set([
  "artwork",
  "cover",
  "cover image",
  "graphic",
  "hero image",
  "image",
  "readme cover",
]);
const privatePathSegments = new Set(["internal", "private", "secrets"]);
const placeholderNamePattern =
  /(?:^|[-_.])(draft|dummy|example|lorem|placeholder|sample|temp|test|tbd|todo)(?:[-_.]|$)/i;

export class PresentationVerificationError extends Error {
  constructor(failures) {
    super(`README presentation verification failed: ${failures.join("; ")}`);
    this.name = "PresentationVerificationError";
    this.failures = [...new Set(failures)];
  }
}

function fail(message) {
  throw new PresentationVerificationError([message]);
}

function normalizedText(content) {
  const normalized = content.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) fail("README and provenance files must use valid line endings.");
  return normalized;
}

function validateReadme(content) {
  const lines = normalizedText(content).split("\n");

  if (lines[0] !== expectedTitle) fail("README title must be the first line: # Agency Workload");
  if (lines[1] !== "") fail("README title must be followed by one blank line.");
  if (lines[2] !== approvedBlockquote) {
    fail("README must use the approved BrainAI Team blockquote with exact HTTPS links.");
  }
  if (lines[3] !== "") fail("README BrainAI Team blockquote must be followed by one blank line.");

  const imageMatch = /^!\[([^\]]*)\]\(([^\s)]+)\)$/.exec(lines[4] ?? "");
  if (!imageMatch) fail("README cover image must immediately follow the BrainAI Team blockquote.");

  const [, altText, imagePath] = imageMatch;
  if (!altText.trim()) fail("README cover image alt text must not be empty.");
  if (genericAltTexts.has(altText.trim().toLowerCase()) || altText !== approvedAltText) {
    fail(
      "README cover image must use the approved descriptive alt text for the published artwork.",
    );
  }

  const imageSegments = imagePath.toLowerCase().split(/[\\/]/);
  if (
    imagePath.startsWith("/") ||
    imagePath.includes("..") ||
    imageSegments.some((segment) => privatePathSegments.has(segment))
  ) {
    fail("README image must not use a private or internal path.");
  }
  if (placeholderNamePattern.test(basename(imagePath))) {
    fail("README image must not use a text-placeholder filename.");
  }
  if (imagePath !== assetPath) fail(`README image path must be exactly ${assetPath}.`);

  if (lines[5] !== "") fail("README cover image must be followed by one blank line.");
  if (lines[6] !== productDescription || lines[7] !== "") {
    fail("README cover image must be followed by the approved one-sentence product description.");
  }

  return imagePath;
}

async function resolveCaseSensitiveFile(root, repositoryPath, missingMessage) {
  const absoluteRoot = resolve(root);
  const rootEntry = await lstat(absoluteRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail("README presentation root must be a real directory.");
  }

  let current = absoluteRoot;
  const segments = repositoryPath.split("/");
  for (const [index, segment] of segments.entries()) {
    const entries = await readdir(current, { withFileTypes: true });
    const entry = entries.find((candidate) => candidate.name === segment);
    if (!entry) {
      if (entries.some((candidate) => candidate.name.toLowerCase() === segment.toLowerCase())) {
        fail(`Repository path case does not match ${repositoryPath}.`);
      }
      fail(missingMessage ?? `Required repository file is missing: ${repositoryPath}`);
    }
    if (entry.isSymbolicLink())
      fail(`Repository presentation file must not be a symlink: ${repositoryPath}`);

    const isLast = index === segments.length - 1;
    if (!isLast && !entry.isDirectory())
      fail(`Repository path is not a directory: ${repositoryPath}`);
    if (isLast && !entry.isFile()) fail(`Repository path is not a regular file: ${repositoryPath}`);
    current = join(current, entry.name);
  }

  return current;
}

async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail("WebP header is truncated.");
  return buffer;
}

function uint24le(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
}

async function parseWebpDimensions(path, fileSize) {
  const handle = await open(path, "r");
  try {
    if (fileSize < 20) fail("README cover must have a valid WebP RIFF signature.");
    const riffHeader = await readExactly(handle, 12, 0);
    if (
      riffHeader.toString("ascii", 0, 4) !== "RIFF" ||
      riffHeader.toString("ascii", 8, 12) !== "WEBP"
    ) {
      fail("README cover must have a valid WebP RIFF signature.");
    }
    if (riffHeader.readUInt32LE(4) + 8 !== fileSize) {
      fail("README cover WebP RIFF length must match the asset byte length.");
    }

    let canvas;
    let imagePayload;
    let offset = 12;
    let chunksRead = 0;
    while (offset < fileSize) {
      if (fileSize - offset < 8) {
        fail("README cover WebP chunk traversal must end exactly at the RIFF file end.");
      }
      chunksRead += 1;
      if (chunksRead > 4096) fail("README cover contains too many WebP chunks.");

      const chunkHeader = await readExactly(handle, 8, offset);
      const chunkType = chunkHeader.toString("ascii", 0, 4);
      const chunkSize = chunkHeader.readUInt32LE(4);
      const dataOffset = offset + 8;
      const dataEnd = dataOffset + chunkSize;
      const paddedEnd = dataEnd + (chunkSize % 2);
      if (dataEnd > fileSize || paddedEnd > fileSize) {
        fail("README cover contains a truncated WebP chunk.");
      }
      if (chunkSize % 2 === 1) {
        const padding = await readExactly(handle, 1, dataEnd);
        if (padding[0] !== 0) fail("README cover contains invalid WebP chunk padding.");
      }

      if (chunkType === "VP8X") {
        if (canvas) fail("README cover must not contain multiple VP8X chunks.");
        if (chunkSize !== 10) fail("README cover contains an invalid VP8X header.");
        const data = await readExactly(handle, 10, dataOffset);
        if ((data[0] & 0x02) !== 0) fail("README cover animation is not allowed.");
        if ((data[0] & 0xc1) !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0) {
          fail("README cover contains invalid VP8X reserved bits.");
        }
        canvas = { height: uint24le(data, 7) + 1, width: uint24le(data, 4) + 1 };
      } else if (chunkType === "ANIM" || chunkType === "ANMF") {
        fail("README cover animation chunks are not allowed.");
      } else if (chunkType === "VP8 ") {
        if (imagePayload) fail("README cover must contain exactly one VP8 or VP8L image payload.");
        if (chunkSize < 10) fail("README cover contains an invalid VP8 header.");
        const data = await readExactly(handle, 10, dataOffset);
        if ((data[0] & 0x01) !== 0) fail("README cover VP8 payload must contain a key frame.");
        if (data[3] !== 0x9d || data[4] !== 0x01 || data[5] !== 0x2a) {
          fail("README cover contains an invalid VP8 frame signature.");
        }
        imagePayload = {
          height: data.readUInt16LE(8) & 0x3fff,
          width: data.readUInt16LE(6) & 0x3fff,
        };
        if (imagePayload.width === 0 || imagePayload.height === 0) {
          fail("README cover contains invalid VP8 dimensions.");
        }
      } else if (chunkType === "VP8L") {
        if (imagePayload) fail("README cover must contain exactly one VP8 or VP8L image payload.");
        if (chunkSize < 5) fail("README cover contains an invalid VP8L header.");
        const data = await readExactly(handle, 5, dataOffset);
        if (data[0] !== 0x2f) fail("README cover contains an invalid VP8L frame signature.");
        if (data[4] >> 5 !== 0) fail("README cover contains an unsupported VP8L version.");
        imagePayload = {
          height: 1 + ((data[2] >> 6) | (data[3] << 2) | ((data[4] & 0x0f) << 10)),
          width: 1 + data[1] + ((data[2] & 0x3f) << 8),
        };
      }

      offset = paddedEnd;
    }

    if (offset !== fileSize) {
      fail("README cover WebP chunk traversal must end exactly at the RIFF file end.");
    }
    if (!imagePayload) fail("README cover must contain one real VP8 or VP8L image payload.");
    if (canvas && (canvas.width !== imagePayload.width || canvas.height !== imagePayload.height)) {
      fail("README cover VP8X canvas must agree with the image payload dimensions.");
    }
    return imagePayload;
  } finally {
    await handle.close();
  }
}

async function verifyFullWebpDecode(path, structuralDimensions) {
  let encoded = await readFile(path);
  const decoder = sharp(encoded, {
    animated: true,
    failOn: "warning",
    limitInputChannels: maxDecodedChannels,
    limitInputPixels: maxDecodedPixels,
    sequentialRead: true,
  });
  let pixels;
  try {
    const metadata = await decoder.metadata();
    const pages = metadata.pages ?? 1;
    if (metadata.format !== "webp") fail("README cover decoded format must be WebP.");
    if (metadata.width !== expectedWidth || metadata.height !== expectedHeight) {
      fail("README cover decoded dimensions must be exactly 1600x900.");
    }
    if (
      metadata.width !== structuralDimensions.width ||
      metadata.height !== structuralDimensions.height
    ) {
      fail("README cover decoded dimensions must agree with its WebP payload.");
    }
    if (
      pages !== 1 ||
      metadata.pageHeight !== undefined ||
      metadata.delay !== undefined ||
      metadata.loop !== undefined
    ) {
      fail("README cover must decode as one non-animated page.");
    }
    if (
      metadata.channels === undefined ||
      metadata.channels < minDecodedChannels ||
      metadata.channels > maxDecodedChannels
    ) {
      fail("README cover must decode to three or four channels.");
    }

    const decoded = await decoder.raw().toBuffer({ resolveWithObject: true });
    pixels = decoded.data;
    if (
      decoded.info.width !== expectedWidth ||
      decoded.info.height !== expectedHeight ||
      decoded.info.channels !== metadata.channels
    ) {
      fail("README cover raw decode metadata must match the inspected image.");
    }
    const expectedBytes = expectedWidth * expectedHeight * decoded.info.channels;
    if (pixels.length !== expectedBytes || decoded.info.size !== expectedBytes) {
      fail("README cover raw decode byte length must match width x height x channels.");
    }

    return { channels: decoded.info.channels };
  } catch (error) {
    if (error instanceof PresentationVerificationError) throw error;
    fail("README cover must fully decode without warnings or errors.");
  } finally {
    encoded = undefined;
    pixels = undefined;
    decoder.destroy();
  }
}

async function verifyNoSourceSibling(path) {
  const assetName = basename(path, ".webp").toLowerCase();
  const sourceSibling = (await readdir(dirname(path))).find((name) => {
    const lowerName = name.toLowerCase();
    return [".jpeg", ".jpg", ".png"].some((extension) => lowerName === `${assetName}${extension}`);
  });
  if (sourceSibling) fail(`README cover has a forbidden source PNG/JPEG sibling: ${sourceSibling}`);
}

async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function sha256Text(content) {
  return createHash("sha256").update(content).digest("hex");
}

function provenanceField(content, field) {
  const escapedField = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\*\\*${escapedField}:\\*\\* (.+)$`, "m").exec(content)?.[1];
}

function provenanceSection(content, heading) {
  const marker = `## ${heading}\n\n`;
  const start = content.indexOf(marker);
  if (start === -1) return undefined;
  const bodyStart = start + marker.length;
  const bodyEnd = content.indexOf("\n\n## ", bodyStart);
  return content.slice(bodyStart, bodyEnd === -1 ? undefined : bodyEnd).trim();
}

function isValidGeneratedDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? "")) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function hasExactKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key, index) => actualKeys[index] === key)
  );
}

function parseExpectedRecord(content) {
  let record;
  try {
    record = JSON.parse(content);
  } catch {
    fail("README artwork expected record must be valid JSON.");
  }

  const topLevelKeys = ["asset", "generatedDate", "version"];
  const assetKeys = ["bytes", "sha256"];
  if (
    !hasExactKeys(record, topLevelKeys) ||
    record.version !== 1 ||
    !isValidGeneratedDate(record.generatedDate) ||
    !hasExactKeys(record.asset, assetKeys) ||
    !Number.isSafeInteger(record.asset.bytes) ||
    record.asset.bytes <= 0 ||
    record.asset.bytes > maxAssetBytes ||
    typeof record.asset.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(record.asset.sha256)
  ) {
    fail("README artwork expected record must match the strict schema.");
  }
  return record;
}

function verifyExpectedRecord(record, asset) {
  if (record.asset.bytes !== asset.bytes) {
    fail("README artwork expected record bytes must match the actual asset.");
  }
  if (record.asset.sha256 !== asset.sha256) {
    fail("README artwork expected record SHA-256 must match the actual asset.");
  }
}

function verifyProvenance(content, asset, expectedRecord) {
  const normalized = normalizedText(content);
  if (provenanceField(normalized, "Published asset") !== `\`${assetPath}\``) {
    fail("Provenance Published asset must match the README image path.");
  }
  if (provenanceField(normalized, "Published size") !== `${asset.width}x${asset.height} WebP`) {
    fail("Provenance Published size must match the WebP asset.");
  }
  const publishedBytes = provenanceField(normalized, "Published bytes");
  if (publishedBytes !== String(asset.bytes)) {
    fail("Provenance Published bytes must match the asset.");
  }
  if (publishedBytes !== String(expectedRecord.asset.bytes)) {
    fail("Provenance Published bytes must match the private expected record.");
  }
  const publishedSha256 = provenanceField(normalized, "SHA-256");
  if (publishedSha256 !== `\`${asset.sha256}\``) {
    fail("Provenance SHA-256 must match the asset.");
  }
  if (publishedSha256 !== `\`${expectedRecord.asset.sha256}\``) {
    fail("Provenance SHA-256 must match the private expected record.");
  }
  const generatedDate = provenanceField(normalized, "Generated");
  if (!isValidGeneratedDate(generatedDate)) {
    fail("Provenance Generated date must be a valid YYYY-MM-DD value.");
  }
  if (generatedDate !== expectedRecord.generatedDate) {
    fail("Provenance Generated date must match the private expected record.");
  }
  if (
    sha256Text(provenanceField(normalized, "Source/reference assets") ?? "") !==
    provenanceFingerprints.sourceReference
  ) {
    fail("Provenance Source/reference assets must match the approved asset provenance.");
  }
  if (sha256Text(provenanceField(normalized, "Rights") ?? "") !== provenanceFingerprints.rights) {
    fail("Provenance Rights must match the approved asset provenance.");
  }
  if (sha256Text(provenanceField(normalized, "Model") ?? "") !== provenanceFingerprints.model) {
    fail("Provenance Model must match the approved asset provenance.");
  }
  if (
    sha256Text(provenanceSection(normalized, "Final Prompt") ?? "") !==
    provenanceFingerprints.prompt
  ) {
    fail("Provenance Final Prompt must match the approved asset provenance.");
  }
  if (
    sha256Text(provenanceSection(normalized, "Processing") ?? "") !==
    provenanceFingerprints.processing
  ) {
    fail("Provenance Processing must match the approved asset provenance.");
  }
}

export async function verifyReadmePresentation(root, { origin } = {}) {
  let exactOrigin = origin;
  if (exactOrigin === undefined) {
    try {
      exactOrigin = readExactOrigin(root);
    } catch (error) {
      fail(
        error instanceof Error
          ? error.message
          : "Unable to read the repository origin remote safely.",
      );
    }
  }
  if (exactOrigin !== PRIVATE_CANONICAL_ORIGIN && exactOrigin !== PUBLIC_MIRROR_ORIGIN) {
    fail(
      "README presentation verification requires the exact private canonical or public mirror origin.",
    );
  }

  const absoluteReadme = await resolveCaseSensitiveFile(root, readmePath);
  const imagePath = validateReadme(await readFile(absoluteReadme, "utf8"));
  const absoluteAsset = await resolveCaseSensitiveFile(root, imagePath);
  await verifyNoSourceSibling(absoluteAsset);

  const assetEntry = await lstat(absoluteAsset);
  if (assetEntry.size > maxAssetBytes) fail("README cover must be 500 KiB or smaller.");
  const dimensions = await parseWebpDimensions(absoluteAsset, assetEntry.size);
  if (dimensions.width !== expectedWidth || dimensions.height !== expectedHeight) {
    fail("README cover must be exactly 1600x900.");
  }
  await verifyFullWebpDecode(absoluteAsset, dimensions);

  const asset = {
    bytes: assetEntry.size,
    ...dimensions,
    sha256: await sha256File(absoluteAsset),
  };
  let provenance = "not-required";
  if (exactOrigin === PRIVATE_CANONICAL_ORIGIN) {
    const absoluteProvenance = await resolveCaseSensitiveFile(
      root,
      provenancePath,
      `README artwork provenance is missing: ${provenancePath}`,
    );
    const absoluteExpectedRecord = await resolveCaseSensitiveFile(
      root,
      expectedRecordPath,
      `README artwork expected record is missing: ${expectedRecordPath}`,
    );
    const expectedRecord = parseExpectedRecord(await readFile(absoluteExpectedRecord, "utf8"));
    verifyExpectedRecord(expectedRecord, asset);
    verifyProvenance(await readFile(absoluteProvenance, "utf8"), asset, expectedRecord);
    provenance = "verified";
  }

  return { ...asset, provenance };
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const result = await verifyReadmePresentation(projectRoot);
    console.log(
      `Verified README presentation: ${result.width}x${result.height} WebP, ${result.bytes} bytes, provenance ${result.provenance}.`,
    );
  } catch (error) {
    if (error instanceof PresentationVerificationError) {
      console.error("README presentation verification failed:\n");
      for (const failure of error.failures) console.error(`- ${failure}`);
    } else {
      console.error("README presentation verification failed unexpectedly.");
    }
    process.exitCode = 1;
  }
}
