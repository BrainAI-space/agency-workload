import { spawnSync } from "node:child_process";

const [testFile] = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith("--smoke-process-marker="));
if (!testFile) throw new Error("Auth integration test file is required");
const result = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", testFile], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
process.exitCode = result.status ?? 1;
