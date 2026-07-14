import { createHmac } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import pg from "pg";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const evidenceDirectory = join(projectRoot, "test-results", "browser-smoke");

const { BOOTSTRAP_EMAIL, DATABASE_URL, SESSION_SECRET } = process.env;
if (!BOOTSTRAP_EMAIL || !DATABASE_URL || !SESSION_SECRET) {
  throw new Error("Browser smoke requires the local runtime configuration");
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
try {
  const emailHash = createHmac("sha256", SESSION_SECRET)
    .update(BOOTSTRAP_EMAIL.trim().toLowerCase(), "utf8")
    .digest();
  await pool.query("DELETE FROM app.auth_requests WHERE email_hash = $1", [emailHash]);
} finally {
  await pool.end();
}

await fetch("http://127.0.0.1:8025/api/v1/messages", {
  method: "DELETE",
  headers: { "content-type": "application/json" },
  body: "{}",
});

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const browserErrors = [];
const networkEvidence = [];
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push("console error");
});
page.on("pageerror", () => browserErrors.push("page error"));
page.on("response", (response) => {
  const url = new URL(response.url());
  if (url.origin === "http://localhost:3100" || url.pathname.startsWith("/api/")) {
    networkEvidence.push({
      method: response.request().method(),
      path: url.pathname,
      status: response.status(),
    });
  }
});

async function captureSanitizedFailure(errorType) {
  await mkdir(evidenceDirectory, { recursive: true });
  await page.locator("input, textarea").evaluateAll((elements) => {
    for (const element of elements) element.value = "";
  });
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      node.textContent = (node.textContent ?? "")
        .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
        .replace(/\b\d{6}\b/g, "[redacted-code]");
    }
  });
  await page.screenshot({ path: join(evidenceDirectory, "failure.png"), fullPage: true });
  const currentUrl = new URL(page.url());
  const summary = {
    errorType,
    path: currentUrl.pathname,
    title: await page.title(),
    headings: await page.locator("h1, h2").allTextContents(),
    labels: await page.locator("label").allTextContents(),
    consoleCategories: [...new Set(browserErrors)],
    network: networkEvidence.slice(-30),
  };
  await writeFile(
    join(evidenceDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
}

try {
  await page.goto("http://localhost:3100/login", { waitUntil: "networkidle" });
  await page.getByLabel("Work email").fill(BOOTSTRAP_EMAIL);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByRole("heading", { name: "Enter your code" }).waitFor();

  let code = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch("http://127.0.0.1:8025/api/v1/message/latest/raw");
    if (response.ok) {
      const raw = await response.text();
      code = raw.match(/one-time code is: (\d{6})/i)?.[1] ?? "";
      if (code) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!code) throw new Error("Browser smoke did not receive a local OTP");

  await page.getByLabel("Six-digit code").fill(code);
  code = "";
  await page.getByRole("button", { name: "Open workspace" }).click();
  await page.waitForURL("**/schedule");
  await page.getByRole("heading", { name: "Schedule" }).waitFor();
  if (!(await page.getByRole("table", { name: "People by week" }).isVisible())) {
    throw new Error("Desktop schedule table is not visible");
  }
  const storageState = await page.evaluate(() => ({
    local: window.localStorage.length,
    email: window.sessionStorage.getItem("agency-workload:login-email"),
  }));
  if (storageState.local !== 0 || storageState.email !== null) {
    throw new Error("Browser storage boundary failed");
  }

  await page.getByRole("link", { name: "Admin" }).click();
  await page.waitForURL("**/admin/members");
  await page.getByRole("heading", { name: "Members" }).waitFor();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("http://localhost:3100/schedule", { waitUntil: "networkidle" });
  if (!(await page.getByRole("navigation", { name: "Mobile navigation" }).isVisible())) {
    throw new Error("Mobile navigation is not visible");
  }
  if (!(await page.getByRole("region", { name: "Weekly brief" }).isVisible())) {
    throw new Error("Mobile weekly brief is not visible");
  }
  await page.getByRole("link", { name: "More" }).click();
  await page.waitForURL("**/more");
  await page.getByRole("link", { name: "Leave" }).click();
  await page.waitForURL("**/leave");
  await page.goto("http://localhost:3100/more", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Administration" }).click();
  await page.waitForURL("**/admin/members");
  await page.keyboard.press("Tab");
  if (!(await page.evaluate(() => document.activeElement !== document.body))) {
    throw new Error("Keyboard focus did not enter the interface");
  }
  if (browserErrors.length > 0) throw new Error("Browser console reported errors");
  console.log(
    "Browser smoke verified login, protected schedule, mobile More-to-Leave/Admin navigation, mobile brief, and storage boundaries.",
  );
} catch (error) {
  await captureSanitizedFailure(error instanceof Error ? error.name : "UnknownError");
  throw new Error(
    "Browser smoke failed; sanitized evidence written to test-results/browser-smoke.",
  );
} finally {
  await browser.close();
  await fetch("http://127.0.0.1:8025/api/v1/messages", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: "{}",
  }).catch(() => undefined);
}
