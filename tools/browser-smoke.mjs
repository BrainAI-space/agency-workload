import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import {
  assertDestinationRequestsCompleted,
  assertNetworkHealthy,
  completionSnapshot,
  createNetworkState,
  recordApiResponse,
  recordApiTransportFailure,
  requiredSchedulePaths,
} from "./lib/browser-smoke-network.mjs";
import { safeBrowserSmokeStage } from "./lib/browser-smoke-stage.mjs";

const projectRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const evidenceDirectory = join(projectRoot, "test-results", "browser-smoke");
const failureArtifactDirectory = join(
  evidenceDirectory,
  `failure-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`,
);
const readinessTimeoutMs = 15_000;
const idleWindowMs = 500;

const fixedHeadings = Object.freeze([
  ["login", "Sign in to Agency Workload"],
  ["otp", "Enter your code"],
  ["schedule", "Schedule"],
  ["members", "Members"],
  ["leave", "Leave"],
]);
const fixedLabels = Object.freeze([
  ["work-email", "Work email"],
  ["otp-code", "Six-digit code"],
]);
const screenshotTextAllowlist = Object.freeze([
  "Agency Workload",
  "Sign in to Agency Workload",
  "Work email",
  "Continue with email",
  "Enter your code",
  "Six-digit code",
  "Open workspace",
  "Schedule",
  "Members",
  "Leave",
  "No people yet",
  "Confirmed",
  "Tentative",
  "Available",
  "Over capacity",
  "Loading members...",
  "Updating schedule…",
]);
const readinessCheckpoints = new Set([
  "not-started",
  "login",
  "otp",
  "schedule-url",
  "schedule-heading",
  "schedule-loading",
  "planning-board",
  "schedule-table",
  "weekly-brief",
  "schedule-requests",
  "members-url",
  "members-heading",
  "members-loading",
  "members-request",
  "leave-url",
  "leave-heading",
  "api-idle",
  "keyboard-focus",
]);

function requiredEnvironment(key) {
  const value = process.env[key];
  if (!value) throw new Error(`Browser smoke environment is missing ${key}`);
  return value;
}

function parseOrigin(value, hostname, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Browser smoke ${label} is invalid`);
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== hostname ||
    !url.port ||
    url.pathname !== "/" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Browser smoke ${label} is unsafe`);
  }
  return url.origin;
}

const appOrigin = parseOrigin(requiredEnvironment("APP_ORIGIN"), "localhost", "app origin");
const mailpitOrigin = parseOrigin(
  requiredEnvironment("MAILPIT_ORIGIN"),
  "127.0.0.1",
  "mail origin",
);
const bootstrapEmail = requiredEnvironment("BOOTSTRAP_EMAIL");
if (!/^smoke-owner-[a-f0-9]{32}@agency-workload\.local$/.test(bootstrapEmail)) {
  throw new Error("Browser smoke owner identity is unsafe");
}
const processMarker = requiredEnvironment("SMOKE_PROCESS_MARKER");
const browserProfileDirectory = requiredEnvironment("SMOKE_BROWSER_PROFILE");
if (
  !/^agency-workload-smoke-[a-f0-9]{32}-browser$/.test(processMarker) ||
  basename(browserProfileDirectory) !== `${processMarker}-profile`
) {
  throw new Error("Browser smoke process marker or profile is unsafe");
}

let stage = "startup";
let readinessCheckpoint = "not-started";
let page;
let browser;
let otp = "";
let failure = null;
const browserErrorCategories = new Set();
const pendingApiRequests = new Set();
const networkState = createNetworkState();

function markStage(nextStage) {
  const safeStage = safeBrowserSmokeStage(nextStage);
  if (safeStage === "unknown") throw new Error("Browser smoke stage is not allowlisted");
  stage = safeStage;
}

function markCheckpoint(checkpoint) {
  if (!readinessCheckpoints.has(checkpoint)) {
    throw new Error("Browser smoke readiness checkpoint is not allowlisted");
  }
  readinessCheckpoint = checkpoint;
}

function apiPath(value) {
  try {
    const url = new URL(value);
    return url.origin === appOrigin && url.pathname.startsWith("/api/") ? url.pathname : null;
  } catch {
    return null;
  }
}

async function waitForApiIdle() {
  markCheckpoint("api-idle");
  const deadline = Date.now() + readinessTimeoutMs;
  let idleSince = null;
  while (Date.now() < deadline) {
    assertNetworkHealthy(networkState);
    if (pendingApiRequests.size === 0) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= idleWindowMs) return;
    } else {
      idleSince = null;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Browser smoke API requests did not settle");
}

async function waitForScheduleReady(mode, baseline) {
  markCheckpoint("schedule-url");
  await page.waitForURL("**/schedule", { timeout: readinessTimeoutMs });
  markCheckpoint("schedule-heading");
  await page
    .getByRole("heading", { name: "Schedule" })
    .waitFor({ state: "visible", timeout: readinessTimeoutMs });
  markCheckpoint("schedule-loading");
  await page
    .getByText("Updating schedule…", { exact: true })
    .waitFor({ state: "hidden", timeout: readinessTimeoutMs });
  markCheckpoint("planning-board");
  await page
    .locator('[aria-label="Desktop planning board"][aria-busy="false"]')
    .waitFor({ state: mode === "desktop" ? "visible" : "attached", timeout: readinessTimeoutMs });
  markCheckpoint("schedule-table");
  await page
    .locator('table[aria-label="People by week"]')
    .waitFor({ state: mode === "desktop" ? "visible" : "attached", timeout: readinessTimeoutMs });
  markCheckpoint("weekly-brief");
  await page
    .locator('[aria-label="Weekly brief"]')
    .waitFor({ state: mode === "mobile" ? "visible" : "attached", timeout: readinessTimeoutMs });
  await waitForApiIdle();
  markCheckpoint("schedule-requests");
  assertDestinationRequestsCompleted(networkState, requiredSchedulePaths, baseline);
  assertNetworkHealthy(networkState);
}

async function waitForMembersReady(baseline) {
  markCheckpoint("members-url");
  await page.waitForURL("**/admin/members", { timeout: readinessTimeoutMs });
  markCheckpoint("members-heading");
  await page
    .getByRole("heading", { name: "Members" })
    .waitFor({ state: "visible", timeout: readinessTimeoutMs });
  markCheckpoint("members-loading");
  await page
    .getByText("Loading members...", { exact: true })
    .waitFor({ state: "hidden", timeout: readinessTimeoutMs });
  await waitForApiIdle();
  markCheckpoint("members-request");
  assertDestinationRequestsCompleted(networkState, ["/api/v1/admin/memberships"], baseline);
  assertNetworkHealthy(networkState);
}

async function listIsolatedMessages() {
  const response = await fetch(`${mailpitOrigin}/api/v1/messages?start=0&limit=50`, {
    redirect: "error",
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("Browser smoke could not inspect isolated mail");
  const body = await response.json();
  if (!body || !Array.isArray(body.messages) || body.messages.length !== body.total) {
    throw new Error("Browser smoke isolated mailbox response is incomplete");
  }
  return body.messages;
}

async function waitForOtp() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const messages = await listIsolatedMessages();
    const matching = messages.filter(
      (message) =>
        Array.isArray(message?.To) &&
        message.To.some(
          (recipient) =>
            typeof recipient?.Address === "string" &&
            recipient.Address.toLowerCase() === bootstrapEmail,
        ),
    );
    if (matching.length > 1) throw new Error("Browser smoke isolated mailbox is ambiguous");
    const messageId = matching[0]?.ID;
    if (typeof messageId === "string" && messageId) {
      const response = await fetch(
        `${mailpitOrigin}/api/v1/message/${encodeURIComponent(messageId)}/raw`,
        { redirect: "error", signal: AbortSignal.timeout(2_000) },
      );
      if (response.ok) {
        const raw = await response.text();
        const code = raw.match(/one-time code is: (\d{6})/i)?.[1];
        if (code) return code;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Browser smoke did not receive its isolated OTP");
}

function safeCheckpoint(value) {
  return readinessCheckpoints.has(value) ? value : "unknown";
}

function pageCategory() {
  if (!page) return "unavailable";
  try {
    const pathname = new URL(page.url()).pathname;
    const categories = new Map([
      ["/login", "login"],
      ["/verify", "otp"],
      ["/schedule", "schedule"],
      ["/admin/members", "members"],
      ["/more", "more"],
      ["/leave", "leave"],
    ]);
    return categories.get(pathname) ?? "unknown";
  } catch {
    return "unknown";
  }
}

async function visibleFixedCategories(entries, role) {
  if (!page) return [];
  const visible = [];
  for (const [category, text] of entries) {
    const locator = page.getByRole(role, { name: text, exact: true });
    if (
      (await locator.count()) > 0 &&
      (await locator
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      visible.push(category);
    }
  }
  return visible;
}

async function sanitizePageForScreenshot() {
  if (!page) return;
  await page.evaluate((allowlist) => {
    const allowed = new Set(allowlist);
    for (const element of document.querySelectorAll("input, textarea, [contenteditable='true']")) {
      if ("value" in element) element.value = "";
      element.textContent = "";
      element.removeAttribute("value");
    }
    for (const element of document.querySelectorAll("img, canvas, video")) {
      element.style.visibility = "hidden";
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = (node.textContent ?? "").trim();
      if (text && !allowed.has(text)) node.textContent = "[redacted]";
    }
  }, screenshotTextAllowlist);
}

async function captureSanitizedFailure() {
  await mkdir(failureArtifactDirectory, { recursive: true });
  const summary = {
    category: "browser-smoke-failure",
    stage: safeBrowserSmokeStage(stage),
    readinessCheckpoint: safeCheckpoint(readinessCheckpoint),
    pageCategory: pageCategory(),
    headingCategories: await visibleFixedCategories(fixedHeadings, "heading"),
    labelCategories: await visibleFixedCategories(fixedLabels, "textbox"),
    browserCategories: [...browserErrorCategories].sort(),
    networkCategories: [
      {
        category: "api-response-failure",
        count: Math.min(999, networkState.responseFailures),
      },
      {
        category: "api-transport-failure",
        count: Math.min(999, networkState.transportFailures),
      },
      { category: "api-pending", count: Math.min(999, pendingApiRequests.size) },
    ],
  };
  await writeFile(
    join(failureArtifactDirectory, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );
  if (page) {
    await sanitizePageForScreenshot();
    await page.screenshot({
      path: join(failureArtifactDirectory, "failure.png"),
      fullPage: true,
    });
  }
}

try {
  browser = await chromium.launchPersistentContext(browserProfileDirectory, {
    args: [`--agency-workload-smoke-marker=${processMarker}`],
    headless: true,
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on("console", (message) => {
    if (message.type() === "error") browserErrorCategories.add("console-error");
  });
  page.on("pageerror", () => browserErrorCategories.add("page-error"));
  page.on("request", (request) => {
    if (apiPath(request.url())) pendingApiRequests.add(request);
  });
  page.on("requestfinished", (request) => {
    pendingApiRequests.delete(request);
  });
  page.on("requestfailed", (request) => {
    if (!apiPath(request.url())) return;
    pendingApiRequests.delete(request);
    recordApiTransportFailure(networkState);
  });
  page.on("response", (response) => {
    const path = apiPath(response.url());
    if (!path) return;
    recordApiResponse(networkState, {
      method: response.request().method(),
      path,
      status: response.status(),
    });
  });

  markStage("login-transition");
  markCheckpoint("login");
  await page.goto(`${appOrigin}/login`, { waitUntil: "networkidle" });
  await page.getByLabel("Work email").fill(bootstrapEmail);
  await page.getByRole("button", { name: "Continue with email" }).click();
  markCheckpoint("otp");
  await page
    .getByRole("heading", { name: "Enter your code" })
    .waitFor({ state: "visible", timeout: readinessTimeoutMs });
  await waitForApiIdle();
  markStage("otp-wait");
  assertNetworkHealthy(networkState);

  otp = await waitForOtp();
  await page.getByLabel("Six-digit code").fill(otp);
  otp = "";
  const desktopScheduleBaseline = completionSnapshot(networkState, requiredSchedulePaths);
  markStage("desktop-schedule-transition");
  await page.getByRole("button", { name: "Open workspace" }).click();
  await waitForScheduleReady("desktop", desktopScheduleBaseline);
  markStage("desktop-schedule-ready");

  const storageState = await page.evaluate(() => ({
    local: window.localStorage.length,
    email: window.sessionStorage.getItem("agency-workload:login-email"),
  }));
  if (storageState.local !== 0 || storageState.email !== null) {
    throw new Error("Browser smoke storage boundary failed");
  }

  const desktopMembersBaseline = completionSnapshot(networkState, ["/api/v1/admin/memberships"]);
  markStage("desktop-admin-transition");
  await page.getByRole("link", { name: "Admin" }).click();
  await waitForMembersReady(desktopMembersBaseline);
  markStage("desktop-admin-ready");

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileScheduleBaseline = completionSnapshot(networkState, requiredSchedulePaths);
  markStage("mobile-schedule-transition");
  await page.goto(`${appOrigin}/schedule`, { waitUntil: "networkidle" });
  await waitForScheduleReady("mobile", mobileScheduleBaseline);
  if (!(await page.getByRole("navigation", { name: "Mobile navigation" }).isVisible())) {
    throw new Error("Browser smoke mobile navigation is unavailable");
  }
  markStage("mobile-schedule-ready");

  markStage("mobile-more-transition");
  await page.getByRole("link", { name: "More" }).click();
  await page.waitForURL("**/more", { timeout: readinessTimeoutMs });
  await waitForApiIdle();
  markStage("mobile-leave-transition");
  await page.getByRole("link", { name: "Leave" }).click();
  markCheckpoint("leave-url");
  await page.waitForURL("**/leave", { timeout: readinessTimeoutMs });
  markCheckpoint("leave-heading");
  await page
    .getByRole("heading", { name: "Leave" })
    .waitFor({ state: "visible", timeout: readinessTimeoutMs });
  await waitForApiIdle();
  assertNetworkHealthy(networkState);
  markStage("mobile-leave-ready");

  markStage("mobile-more-transition");
  await page.goto(`${appOrigin}/more`, { waitUntil: "networkidle" });
  await waitForApiIdle();
  const mobileMembersBaseline = completionSnapshot(networkState, ["/api/v1/admin/memberships"]);
  markStage("mobile-admin-transition");
  await page.getByRole("link", { name: "Administration" }).click();
  await waitForMembersReady(mobileMembersBaseline);
  markStage("mobile-admin-ready");

  markCheckpoint("keyboard-focus");
  await page.keyboard.press("Tab");
  if (!(await page.evaluate(() => document.activeElement !== document.body))) {
    throw new Error("Browser smoke keyboard focus is unavailable");
  }
  assertNetworkHealthy(networkState);
  if (browserErrorCategories.size > 0) throw new Error("Browser smoke reported browser errors");
  markStage("keyboard-focus");
} catch {
  otp = "";
  await captureSanitizedFailure().catch(() => undefined);
  failure = new Error(
    "Browser smoke failed; sanitized evidence is available in test-results/browser-smoke.",
  );
} finally {
  otp = "";
  await browser?.close().catch(() => {
    failure = new Error("Browser smoke browser cleanup failed");
  });
  await rm(browserProfileDirectory, { force: true, recursive: true }).catch(() => {
    failure = new Error("Browser smoke profile cleanup failed");
  });
}

if (failure) throw failure;
console.log(
  "Browser smoke verified isolated OTP login, settled planning requests, protected navigation, and storage boundaries.",
);
