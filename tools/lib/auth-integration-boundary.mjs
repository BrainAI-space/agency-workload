import { createHmac, timingSafeEqual } from "node:crypto";

const tokenPattern = /^[a-f0-9]{64}$/;
const markerPattern = /^agency-workload-smoke-([a-f0-9]{32})-auth$/;
const persistentPorts = new Set([1025, 5434, 8025, 9999]);
const authPortMin = 49_152;
const authPortMax = 60_999;
const manifestKeys = Object.freeze([
  "AW_EXPECTED_APP_ENV",
  "AW_EXPECTED_APP_ORIGIN",
  "AW_EXPECTED_APP_PORT",
  "AW_EXPECTED_BOOTSTRAP_EMAIL",
  "AW_EXPECTED_COMPOSE_PROJECT",
  "AW_EXPECTED_DATABASE_HOST",
  "AW_EXPECTED_DATABASE_NAME",
  "AW_EXPECTED_DATABASE_PORT",
  "AW_EXPECTED_DATABASE_URL",
  "AW_EXPECTED_DATABASE_USER",
  "AW_EXPECTED_GOTRUE_DATABASE_URL",
  "AW_EXPECTED_GOTRUE_ORIGIN",
  "AW_EXPECTED_GOTRUE_PORT",
  "AW_EXPECTED_GOTRUE_SERVICE_ROLE_KEY",
  "AW_EXPECTED_MAILPIT_ORIGIN",
  "AW_EXPECTED_MAILPIT_PORT",
  "AW_EXPECTED_SESSION_SECRET",
  "AW_EXPECTED_SMTP_FROM",
  "AW_EXPECTED_SMTP_HOST",
  "AW_EXPECTED_SMTP_PORT",
  "AW_EXPECTED_SMTP_SENDER_NAME",
]);

function required(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`Disposable auth integration expected target is missing: ${key}`);
  }
  return value;
}

function exactUrl(value, expected, label) {
  let actualUrl;
  let expectedUrl;
  try {
    actualUrl = new URL(value);
    expectedUrl = new URL(expected);
  } catch {
    throw new Error(`Disposable auth integration ${label} is invalid`);
  }
  if (
    actualUrl.toString() !== expectedUrl.toString() ||
    actualUrl.search ||
    actualUrl.hash ||
    actualUrl.username !== expectedUrl.username ||
    actualUrl.pathname !== expectedUrl.pathname
  ) {
    throw new Error(`Disposable auth integration ${label} target mismatch`);
  }
  return actualUrl;
}

export function canonicalAuthTargetManifest(environment) {
  return manifestKeys.map((key) => `${key}=${required(environment, key)}`).join("\n");
}

export function createAuthTargetProof(runToken, canonicalManifest) {
  if (!tokenPattern.test(runToken))
    throw new Error("Disposable auth integration run token is invalid");
  return createHmac("sha256", Buffer.from(runToken, "hex"))
    .update(canonicalManifest, "utf8")
    .digest("hex");
}

function assertPort(value, label) {
  const port = Number(value);
  if (
    !Number.isSafeInteger(port) ||
    port < authPortMin ||
    port > authPortMax ||
    persistentPorts.has(port)
  ) {
    throw new Error(`Disposable auth integration ${label} port is unsafe`);
  }
  return String(port);
}

export function assertExactAuthIntegrationBoundary(environment) {
  const token = required(environment, "AW_DISPOSABLE_RUN_TOKEN");
  if (!tokenPattern.test(token))
    throw new Error("Disposable auth integration run token is invalid");
  const actualProof = required(environment, "AW_DISPOSABLE_TARGET_PROOF");
  if (!/^[a-f0-9]{64}$/.test(actualProof)) {
    throw new Error("Disposable auth integration target proof is invalid");
  }
  const expectedProof = createAuthTargetProof(token, canonicalAuthTargetManifest(environment));
  const expectedProofBytes = Buffer.from(expectedProof, "hex");
  const actualProofBytes = Buffer.from(actualProof, "hex");
  if (
    expectedProofBytes.length !== actualProofBytes.length ||
    !timingSafeEqual(expectedProofBytes, actualProofBytes)
  ) {
    throw new Error("Disposable auth integration target proof mismatch");
  }
  const marker = required(environment, "AW_DISPOSABLE_TEST_MARKER");
  const markerMatch = marker.match(markerPattern);
  if (!markerMatch || markerMatch[1] !== token.slice(0, 32)) {
    throw new Error("Disposable auth integration marker is invalid");
  }

  const databaseUrl = exactUrl(
    required(environment, "DATABASE_URL"),
    required(environment, "AW_EXPECTED_DATABASE_URL"),
    "database URL",
  );
  const gotrueDatabaseUrl = exactUrl(
    required(environment, "GOTRUE_DATABASE_URL"),
    required(environment, "AW_EXPECTED_GOTRUE_DATABASE_URL"),
    "GoTrue database URL",
  );
  const gotrueOrigin = exactUrl(
    required(environment, "GOTRUE_ORIGIN"),
    required(environment, "AW_EXPECTED_GOTRUE_ORIGIN"),
    "GoTrue origin",
  );
  const mailpitOrigin = exactUrl(
    required(environment, "MAILPIT_ORIGIN"),
    required(environment, "AW_EXPECTED_MAILPIT_ORIGIN"),
    "Mailpit origin",
  );

  const expectedDatabaseName = required(environment, "AW_EXPECTED_DATABASE_NAME");
  const expectedDatabaseHost = required(environment, "AW_EXPECTED_DATABASE_HOST");
  const expectedDatabasePort = assertPort(
    required(environment, "AW_EXPECTED_DATABASE_PORT"),
    "database",
  );
  const expectedRuntimeUser = required(environment, "AW_EXPECTED_DATABASE_USER");
  if (
    databaseUrl.protocol !== "postgresql:" ||
    databaseUrl.hostname !== expectedDatabaseHost ||
    databaseUrl.hostname !== "127.0.0.1" ||
    databaseUrl.port !== expectedDatabasePort ||
    databaseUrl.pathname !== `/${expectedDatabaseName}` ||
    decodeURIComponent(databaseUrl.username) !== expectedRuntimeUser ||
    expectedRuntimeUser !== "agency_workload_runtime" ||
    expectedDatabaseName !== `agency_workload_smoke_${markerMatch[1]}`
  ) {
    throw new Error("Disposable auth integration database target mismatch");
  }
  const appOrigin = exactUrl(
    required(environment, "APP_ORIGIN"),
    required(environment, "AW_EXPECTED_APP_ORIGIN"),
    "app origin",
  );
  const expectedAppPort = assertPort(required(environment, "AW_EXPECTED_APP_PORT"), "app");
  if (
    required(environment, "APP_ENV") !== required(environment, "AW_EXPECTED_APP_ENV") ||
    environment.APP_ENV !== "development" ||
    appOrigin.protocol !== "http:" ||
    appOrigin.hostname !== "localhost" ||
    appOrigin.port !== expectedAppPort ||
    appOrigin.pathname !== "/" ||
    required(environment, "BOOTSTRAP_EMAIL") !==
      required(environment, "AW_EXPECTED_BOOTSTRAP_EMAIL") ||
    environment.BOOTSTRAP_EMAIL !== `smoke-owner-${markerMatch[1]}@agency-workload.local` ||
    required(environment, "GOTRUE_SERVICE_ROLE_KEY") !==
      required(environment, "AW_EXPECTED_GOTRUE_SERVICE_ROLE_KEY") ||
    required(environment, "SESSION_SECRET") !== required(environment, "AW_EXPECTED_SESSION_SECRET")
  ) {
    throw new Error("Disposable auth integration application target mismatch");
  }
  if (
    gotrueDatabaseUrl.protocol !== "postgresql:" ||
    gotrueDatabaseUrl.hostname !== expectedDatabaseHost ||
    gotrueDatabaseUrl.hostname !== "127.0.0.1" ||
    gotrueDatabaseUrl.port !== expectedDatabasePort ||
    gotrueDatabaseUrl.pathname !== `/${expectedDatabaseName}` ||
    decodeURIComponent(gotrueDatabaseUrl.username) !== "supabase_auth_admin"
  ) {
    throw new Error("Disposable auth integration GoTrue database target mismatch");
  }

  const expectedGotruePort = assertPort(required(environment, "AW_EXPECTED_GOTRUE_PORT"), "GoTrue");
  const expectedMailpitPort = assertPort(
    required(environment, "AW_EXPECTED_MAILPIT_PORT"),
    "Mailpit",
  );
  const expectedSmtpPort = assertPort(required(environment, "AW_EXPECTED_SMTP_PORT"), "SMTP");
  if (
    new Set([
      expectedAppPort,
      expectedDatabasePort,
      expectedGotruePort,
      expectedMailpitPort,
      expectedSmtpPort,
    ]).size !== 5
  ) {
    throw new Error("Disposable auth integration ports must be distinct");
  }
  if (
    gotrueOrigin.protocol !== "http:" ||
    gotrueOrigin.hostname !== "127.0.0.1" ||
    gotrueOrigin.port !== expectedGotruePort ||
    gotrueOrigin.pathname !== "/" ||
    mailpitOrigin.protocol !== "http:" ||
    mailpitOrigin.hostname !== "127.0.0.1" ||
    mailpitOrigin.port !== expectedMailpitPort ||
    mailpitOrigin.pathname !== "/"
  ) {
    throw new Error("Disposable auth integration service origin mismatch");
  }

  if (
    required(environment, "SMTP_HOST") !== required(environment, "AW_EXPECTED_SMTP_HOST") ||
    environment.SMTP_HOST !== "127.0.0.1" ||
    required(environment, "SMTP_PORT") !== expectedSmtpPort ||
    required(environment, "SMTP_FROM") !== required(environment, "AW_EXPECTED_SMTP_FROM") ||
    required(environment, "SMTP_SENDER_NAME") !==
      required(environment, "AW_EXPECTED_SMTP_SENDER_NAME")
  ) {
    throw new Error("Disposable auth integration SMTP target mismatch");
  }
  if (
    required(environment, "AW_DISPOSABLE_COMPOSE_PROJECT") !==
      required(environment, "AW_EXPECTED_COMPOSE_PROJECT") ||
    environment.AW_DISPOSABLE_COMPOSE_PROJECT !== `agency-workload-smoke-${markerMatch[1]}`
  ) {
    throw new Error("Disposable auth integration Compose project mismatch");
  }
}

export async function pollForRecipientOtp({
  deadlineMs = 5_000,
  fetchImpl = fetch,
  mailpitOrigin,
  now = Date.now,
  recipient,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = now() + Math.min(deadlineMs, 5_000);
  const request = async (url, read) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("Disposable Mailpit OTP deadline exceeded");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(500, remaining));
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      return await read(response);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  const normalized = recipient.toLowerCase();
  while (now() < deadline) {
    try {
      const listed = await request(
        `${mailpitOrigin}/api/v1/messages?start=0&limit=50`,
        async (response) => ({ body: response.ok ? await response.json() : null, ok: response.ok }),
      );
      if (listed.ok) {
        const body = listed.body;
        if (!Array.isArray(body.messages) || body.messages.length !== body.total) {
          throw new Error("Disposable Mailpit message listing is incomplete");
        }
        const matching = body.messages.filter((message) =>
          message.To?.some((address) => address.Address?.toLowerCase() === normalized),
        );
        if (matching.length > 1) throw new Error("Disposable Mailpit recipient is ambiguous");
        const messageId = matching[0]?.ID;
        if (messageId) {
          const rawResponse = await request(
            `${mailpitOrigin}/api/v1/message/${encodeURIComponent(messageId)}/raw`,
            async (response) => ({
              ok: response.ok,
              raw: response.ok ? await response.text() : "",
            }),
          );
          if (rawResponse.ok) {
            const raw = rawResponse.raw;
            const code = raw.match(/one-time code is: (\d{6})/i)?.[1];
            if (code) return { code, raw };
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !/abort|deadline/i.test(error.message)) throw error;
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(100, remaining));
  }
  throw new Error("Disposable Mailpit OTP deadline exceeded");
}
