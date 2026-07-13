import { describe, expect, it } from "vitest";
import { migrationChecksum } from "../src/migrate.js";

describe("migration checksums", () => {
  it("changes when SQL changes and never includes SQL in its output", () => {
    const first = migrationChecksum({ id: "one", up: "SELECT 1", down: "SELECT 2" });
    const second = migrationChecksum({ id: "one", up: "SELECT 3", down: "SELECT 2" });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(second);
    expect(first).not.toContain("SELECT");
  });
});
