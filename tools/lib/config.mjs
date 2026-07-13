import { createHmac, timingSafeEqual } from "node:crypto";

export const expectedTarget = Object.freeze({
  AW_POSTGRES_CONTAINER: "project-postgres",
  AW_POSTGRES_SUPERUSER: "myuser",
  AW_POSTGRES_MAINTENANCE_DB: "mydb",
  AW_POSTGRES_HOST_PORT: "5434",
  AW_DATABASE_NAME: "agency_workload",
});

export const expectedOrigins = Object.freeze({
  APP_ORIGIN: "http://localhost:3100",
  API_ORIGIN: "http://localhost:4100",
  GOTRUE_ORIGIN: "http://127.0.0.1:9999",
  MAILPIT_ORIGIN: "http://127.0.0.1:8025",
});

export const expectedLocal = Object.freeze({
  APP_ENV: "development",
  BOOTSTRAP_EMAIL: "owner@agency-workload.local",
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: "1025",
  SMTP_FROM: "auth@agency-workload.local",
  SMTP_SENDER_NAME: "Agency Workload",
});

export const databaseUrlRules = Object.freeze({
  DATABASE_URL: {
    username: "agency_workload_runtime",
    hostname: "127.0.0.1",
  },
  MIGRATION_DATABASE_URL: {
    username: "agency_workload_migrator",
    hostname: "127.0.0.1",
  },
  GOTRUE_DATABASE_URL: {
    username: "supabase_auth_admin",
    hostname: "host.docker.internal",
  },
  BACKUP_DATABASE_URL: {
    username: "agency_workload_backup",
    hostname: "127.0.0.1",
  },
});

export const directSecretKeys = Object.freeze([
  "GOTRUE_JWT_SECRET",
  "GOTRUE_SERVICE_ROLE_KEY",
  "PENDING_AUTH_KEY",
  "SESSION_SECRET",
]);

export const configurationOrder = Object.freeze([
  ...Object.keys(expectedTarget),
  "",
  ...Object.keys(expectedOrigins),
  ...Object.keys(expectedLocal),
  "",
  ...Object.keys(databaseUrlRules),
  "",
  ...directSecretKeys,
]);

const requiredKeys = Object.freeze([
  ...Object.keys(expectedTarget),
  ...Object.keys(expectedOrigins),
  ...Object.keys(expectedLocal),
  ...Object.keys(databaseUrlRules),
  ...directSecretKeys,
]);

export function parseEnv(text) {
  const values = new Map();
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index].trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trimStart();

    const separator = line.indexOf("=");
    const key = separator === -1 ? "" : line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error(`invalid environment assignment on line ${index + 1}`);
    }
    if (values.has(key)) throw new Error(`duplicate variable ${key} on line ${index + 1}`);

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values.set(key, value);
  }

  return values;
}

export function isPlaceholder(value) {
  return (
    value === "" ||
    value === "GENERATED_BY_LOCAL_BOOTSTRAP" ||
    /^<[^>]+>$/.test(value) ||
    /^(?:change|replace|placeholder)/i.test(value)
  );
}

function encodeJwtPart(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function createServiceRoleToken(secret, { now = Math.floor(Date.now() / 1000) } = {}) {
  const header = encodeJwtPart({ alg: "HS256", typ: "JWT" });
  const payload = encodeJwtPart({
    aud: "authenticated",
    exp: now + 10 * 365 * 24 * 60 * 60,
    iat: now,
    iss: "supabase",
    role: "service_role",
  });
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function hasValidServiceRoleToken(token, secret) {
  try {
    const [headerPart, payloadPart, signaturePart, extraPart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart || extraPart) return false;

    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (
      header.alg !== "HS256" ||
      payload.role !== "service_role" ||
      payload.aud !== "authenticated" ||
      payload.iss !== "supabase" ||
      typeof payload.exp !== "number"
    ) {
      return false;
    }

    const expected = createHmac("sha256", secret).update(`${headerPart}.${payloadPart}`).digest();
    const actual = Buffer.from(signaturePart, "base64url");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function validateDatabaseUrl(key, value, rule, { template }) {
  const failures = [];
  let url;
  try {
    url = new URL(value);
  } catch {
    return [`${key} must be a valid PostgreSQL URL`];
  }

  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    failures.push(`${key} must use the PostgreSQL URL scheme`);
  }
  if (url.username !== rule.username) failures.push(`${key} must use its dedicated role`);
  if (url.hostname !== rule.hostname) failures.push(`${key} must use its fixed local host`);
  if (url.port !== expectedTarget.AW_POSTGRES_HOST_PORT) {
    failures.push(`${key} must use the fixed local PostgreSQL port`);
  }
  if (url.pathname !== `/${expectedTarget.AW_DATABASE_NAME}`) {
    failures.push(`${key} must use the dedicated database`);
  }
  if (url.search || url.hash)
    failures.push(`${key} must not contain query parameters or fragments`);

  if (template) {
    if (!isPlaceholder(decodeURIComponent(url.password))) {
      failures.push(`${key} template password must be an obvious placeholder`);
    }
  } else if (isPlaceholder(url.password) || decodeURIComponent(url.password).length < 32) {
    failures.push(`${key} password is missing or weak`);
  }

  return failures;
}

export function validateConfiguration(values, { template }) {
  const failures = [];

  for (const key of requiredKeys) {
    if (!values.has(key)) failures.push(`missing variable ${key}`);
  }

  for (const key of values.keys()) {
    if (key.startsWith("NEXT_PUBLIC_") || key.startsWith("VITE_")) {
      failures.push(`browser-exposed environment variable is prohibited: ${key}`);
    }
  }

  for (const [key, expected] of Object.entries(expectedTarget)) {
    if (values.has(key) && values.get(key) !== expected) {
      failures.push(`${key} must use the fixed local target`);
    }
  }

  for (const [key, expected] of Object.entries(expectedOrigins)) {
    if (values.has(key) && values.get(key) !== expected) {
      failures.push(`${key} must be the exact local origin`);
    }
  }

  for (const [key, expected] of Object.entries(expectedLocal)) {
    if (values.has(key) && values.get(key) !== expected) {
      failures.push(`${key} must use the fixed local value`);
    }
  }

  for (const [key, rule] of Object.entries(databaseUrlRules)) {
    if (values.has(key)) {
      failures.push(...validateDatabaseUrl(key, values.get(key), rule, { template }));
    }
  }

  for (const key of directSecretKeys) {
    if (!values.has(key)) continue;
    const value = values.get(key);
    if (template) {
      if (!isPlaceholder(value))
        failures.push(`${key} template value must be an obvious placeholder`);
    } else if (isPlaceholder(value) || value.length < 43) {
      failures.push(`${key} is missing or weak`);
    }
  }

  if (
    !template &&
    values.has("GOTRUE_SERVICE_ROLE_KEY") &&
    values.has("GOTRUE_JWT_SECRET") &&
    !hasValidServiceRoleToken(
      values.get("GOTRUE_SERVICE_ROLE_KEY"),
      values.get("GOTRUE_JWT_SECRET"),
    )
  ) {
    failures.push("GOTRUE_SERVICE_ROLE_KEY is not a valid service-role token");
  }

  return failures;
}
