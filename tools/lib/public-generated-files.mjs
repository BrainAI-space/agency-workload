const generatedDirectoryNames = new Set([
  ".next",
  ".turbo",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const syncSourceGeneratedFileSuffixes = [".log", ".pid", ".tsbuildinfo"];

function isGeneratedDirectory(name, entry) {
  return entry.isDirectory() && generatedDirectoryNames.has(name);
}

export function isSyncSourceIgnoredEntry(name, entry) {
  if (entry.isSymbolicLink()) return false;
  if (name === ".git") return entry.isDirectory() || entry.isFile();
  if (isGeneratedDirectory(name, entry)) return true;
  return entry.isFile() && syncSourceGeneratedFileSuffixes.some((suffix) => name.endsWith(suffix));
}

export function isPublicTreeIgnoredEntry(name, entry) {
  if (entry.isSymbolicLink()) return false;
  if (name === ".git") return entry.isDirectory() || entry.isFile();
  if (isGeneratedDirectory(name, entry)) return true;
  return entry.isFile() && name.endsWith(".tsbuildinfo");
}
