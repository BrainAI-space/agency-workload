import { spawnSync } from "node:child_process";

const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", "apps/api/test/planning.integration.test.ts"],
  {
    encoding: "utf8",
    env: { ...process.env, AW_PLANNING_INTEGRATION: "1" },
    stdio: "inherit",
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
