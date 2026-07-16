import { spawnSync } from "node:child_process";

import { POSTGRES_INTEGRATION_SUITES } from "./lib/postgres-integration-boundary.mjs";

const childArguments = process.argv.slice(2);
const markers = childArguments.filter((argument) => argument.startsWith("--smoke-process-marker="));
const argumentsWithoutMarker = childArguments.filter(
  (argument) => !argument.startsWith("--smoke-process-marker="),
);
const [suite, testFile, ...vitestArgs] = argumentsWithoutMarker;
const definition = POSTGRES_INTEGRATION_SUITES[suite];
if (
  !definition ||
  testFile !== definition.testFile ||
  markers.length !== 1 ||
  markers[0] !== `--smoke-process-marker=${process.env.AW_DISPOSABLE_TEST_MARKER}` ||
  vitestArgs.length !== definition.vitestArgs.length ||
  vitestArgs.some((argument, index) => argument !== definition.vitestArgs[index])
) {
  throw new Error("Disposable PostgreSQL integration child target is invalid");
}
const result = spawnSync(
  process.execPath,
  ["node_modules/vitest/vitest.mjs", "run", testFile, ...definition.vitestArgs],
  {
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);
process.exitCode = result.status ?? 1;
