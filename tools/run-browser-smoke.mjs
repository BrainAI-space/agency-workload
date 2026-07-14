import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function startNpm(arguments_) {
  if (process.platform === "win32") {
    return spawn(
      process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", [npm, ...arguments_].join(" ")],
      { cwd: root, stdio: "ignore", windowsHide: true },
    );
  }
  return spawn(npm, arguments_, { cwd: root, stdio: "ignore", windowsHide: true });
}

async function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function waitFor(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Managed browser smoke server did not become ready");
}

function stop(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
}

if ((await portOpen(4100)) || (await portOpen(3100))) {
  throw new Error("Browser smoke requires ports 4100 and 3100 to be free");
}

const api = startNpm(["run", "dev:api"]);
const web = startNpm(["run", "dev:web", "--", "--host", "127.0.0.1"]);

try {
  await Promise.all([
    waitFor("http://127.0.0.1:4100/healthz"),
    waitFor("http://127.0.0.1:3100/login"),
  ]);
  const result = spawnSync(
    process.execPath,
    ["--env-file=.env", join(root, "tools", "browser-smoke.mjs")],
    { cwd: root, encoding: "utf8", stdio: "inherit", windowsHide: true },
  );
  if (result.status !== 0) process.exitCode = result.status ?? 1;
} finally {
  stop(web);
  stop(api);
}
