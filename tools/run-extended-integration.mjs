import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "apps/api/test/extended.integration.test.ts",
    "--testTimeout=30000",
  ],
  {
    encoding: "utf8",
    env: { ...process.env, AW_EXTENDED_INTEGRATION: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
