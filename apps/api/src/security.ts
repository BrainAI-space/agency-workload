import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function normalizeEmail(input: string): string {
  const email = input.trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 254 ||
    !/^[\x21-\x7e]+$/.test(email) ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.includes("..")
  ) {
    throw new Error("Invalid email address");
  }
  return email;
}

export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function verifyOpaqueToken(token: string, expectedHash: Buffer): boolean {
  const actual = hashOpaqueToken(token);
  return actual.length === expectedHash.length && timingSafeEqual(actual, expectedHash);
}

export function keyedHash(value: string, key: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function deriveCsrfToken(sessionToken: string, key: string): string {
  return createHmac("sha256", key).update("csrf\0").update(sessionToken).digest("base64url");
}
