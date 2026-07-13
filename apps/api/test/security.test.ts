import { describe, expect, it } from "vitest";
import {
  deriveCsrfToken,
  hashOpaqueToken,
  newOpaqueToken,
  normalizeEmail,
  verifyOpaqueToken,
} from "../src/security.js";

describe("authentication security primitives", () => {
  it("normalizes safe ASCII email and rejects control, Unicode, and malformed input", () => {
    expect(normalizeEmail("  OWNER@Example.COM ")).toBe("owner@example.com");
    for (const value of ["a@b", "a b@example.com", "a\r\n@example.com", "tést@example.com"]) {
      expect(() => normalizeEmail(value)).toThrow();
    }
  });

  it("stores only fixed-length hashes and compares tokens safely", () => {
    const token = newOpaqueToken();
    const hash = hashOpaqueToken(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hash).toHaveLength(32);
    expect(hash.toString("utf8")).not.toContain(token);
    expect(verifyOpaqueToken(token, hash)).toBe(true);
    expect(verifyOpaqueToken(newOpaqueToken(), hash)).toBe(false);
    const csrf = deriveCsrfToken(token, "k".repeat(64));
    expect(verifyOpaqueToken(csrf, hashOpaqueToken(csrf))).toBe(true);
    expect(deriveCsrfToken(token, "x".repeat(64))).not.toBe(csrf);
  });
});
