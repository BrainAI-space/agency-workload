import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const manifestName = ".mirror-manifest.json";
const ignoredDirectories = new Set([
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const ignoredExtensions = new Set([".tsbuildinfo"]);
const forbiddenSegments = new Set(["backups", "internal", "node_modules", "secrets", "uploads"]);
const forbiddenExtensions = new Set([
  ".cer",
  ".crt",
  ".dump",
  ".key",
  ".log",
  ".p12",
  ".pem",
  ".pfx",
  ".sql",
]);
const secretPatterns = [
  /-----BEGIN (?:EC |OPENSSH |PGP |RSA )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

export class PublicMirrorVerificationError extends Error {
  constructor(failures) {
    super("Public mirror verification failed.");
    this.name = "PublicMirrorVerificationError";
    this.failures = [...new Set(failures)];
  }
}

function publicPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function inspectPath(path, entry, failures) {
  const segments = path.toLowerCase().split("/");
  const fileName = segments.at(-1) ?? "";
  const extension = fileName.includes(".") ? `.${fileName.split(".").at(-1)}` : "";
  let forbidden = false;

  if (segments.some((segment) => forbiddenSegments.has(segment))) {
    failures.push(`Forbidden public path: ${path}`);
    forbidden = true;
  }
  if (entry.isFile() && /^\.env(?:\.|$)/.test(fileName) && !fileName.endsWith(".example")) {
    failures.push(`Environment file is not a safe example: ${path}`);
    forbidden = true;
  }
  if (entry.isFile() && forbiddenExtensions.has(extension)) {
    failures.push(`Forbidden public extension: ${path}`);
    forbidden = true;
  }

  return forbidden;
}

async function walk(root, directory, failures, forbiddenFiles) {
  const files = [];
  for (const name of (await readdir(directory)).sort()) {
    if (name === ".git" || ignoredDirectories.has(name)) continue;

    const path = join(directory, name);
    const entry = await lstat(path);
    const relativePath = publicPath(root, path);
    const extension = name.includes(".") ? `.${name.split(".").at(-1)}` : "";

    if (entry.isFile() && ignoredExtensions.has(extension)) continue;

    if (entry.isSymbolicLink()) {
      failures.push(`Symlink is not allowed publicly: ${relativePath}`);
      continue;
    }

    const forbidden = inspectPath(relativePath, entry, failures);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, path, failures, forbiddenFiles)));
    } else if (entry.isFile()) {
      files.push(relativePath);
      if (forbidden) forbiddenFiles.add(relativePath);
    } else {
      failures.push(`Unsupported public file type: ${relativePath}`);
    }
  }
  return files;
}

function isSafeManifestPath(path) {
  if (typeof path !== "string" || !path || path === manifestName) return false;
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false;
  const segments = path.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

function parseManifest(content, failures) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch {
    failures.push("Public mirror manifest is not valid JSON");
    return new Map();
  }

  if (
    !manifest ||
    Array.isArray(manifest) ||
    !manifest.files ||
    Array.isArray(manifest.files) ||
    typeof manifest.files !== "object"
  ) {
    failures.push("Public mirror manifest must contain a files object");
    return new Map();
  }

  const expectedFiles = new Map();
  for (const [path, hash] of Object.entries(manifest.files)) {
    if (!isSafeManifestPath(path)) {
      failures.push(`Invalid public manifest path: ${path}`);
      continue;
    }
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      failures.push(`Invalid public manifest hash: ${path}`);
      continue;
    }
    expectedFiles.set(path, hash);
  }
  return expectedFiles;
}

export async function verifyPublicCheckout(root) {
  const failures = [];
  const forbiddenFiles = new Set();
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new PublicMirrorVerificationError(["Public checkout root must be a real directory"]);
  }

  const publicFiles = await walk(root, root, failures, forbiddenFiles);
  if (!publicFiles.includes(manifestName)) {
    failures.push("Public mirror manifest is missing or is not a regular file");
    throw new PublicMirrorVerificationError(failures);
  }

  const expectedFiles = parseManifest(await readFile(join(root, manifestName), "utf8"), failures);
  const actualManagedFiles = publicFiles.filter((file) => file !== manifestName).sort();
  const actualManagedFileSet = new Set(actualManagedFiles);

  for (const file of actualManagedFiles) {
    const expectedHash = expectedFiles.get(file);
    if (!expectedHash) failures.push(`Unmanaged public file: ${file}`);
    if (forbiddenFiles.has(file)) continue;

    const content = await readFile(join(root, ...file.split("/")));
    const actualHash = createHash("sha256").update(content).digest("hex");
    if (expectedHash && expectedHash !== actualHash) {
      failures.push(`Public file changed after sync: ${file}`);
    }

    const text = content.toString("utf8");
    if (secretPatterns.some((pattern) => pattern.test(text))) {
      failures.push(`Secret-like content in public file: ${file}`);
    }
  }

  for (const file of expectedFiles.keys()) {
    if (!actualManagedFileSet.has(file)) {
      failures.push(`Missing synchronized public file: ${file}`);
    }
  }

  if (failures.length > 0) throw new PublicMirrorVerificationError(failures);
  return { fileCount: actualManagedFiles.length };
}
