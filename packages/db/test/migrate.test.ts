import { describe, expect, it } from "vitest";
import {
  assertAppliedMigrationHistory,
  migrationChecksum,
  migrationDownChecksum,
} from "../src/migrate.js";

const registry = ["0001_first", "0002_second", "0003_third"].map((id) => ({
  id,
  up: `SELECT '${id}'`,
  down: `SELECT '${id}'`,
}));

describe("applied migration history", () => {
  it("accepts empty history and every exact local prefix", () => {
    expect(() => assertAppliedMigrationHistory([], registry)).not.toThrow();
    for (let count = 1; count <= registry.length; count += 1) {
      expect(() =>
        assertAppliedMigrationHistory(
          registry.slice(0, count).map((migration) => migration.id),
          registry,
        ),
      ).not.toThrow();
    }
  });

  it.each([
    {
      name: "newer database with an older registry",
      applied: ["0001_first", "0002_second", "0003_third"],
      local: registry.slice(0, 2),
    },
    {
      name: "missing middle migration",
      applied: ["0001_first", "0003_third"],
      local: registry,
    },
    {
      name: "extra unknown migration",
      applied: ["0001_first", "0002_second", "9999_unknown"],
      local: registry,
    },
    {
      name: "duplicate migration",
      applied: ["0001_first", "0001_first"],
      local: registry,
    },
    {
      name: "out-of-order migration",
      applied: ["0002_second", "0001_first"],
      local: registry,
    },
  ])("rejects $name", ({ applied, local }) => {
    expect(() => assertAppliedMigrationHistory(applied, local)).toThrow(
      "Applied migration history is not an exact local prefix",
    );
  });
});

describe("migration checksums", () => {
  it("keeps the existing up checksum bound only to the ID and up SQL", () => {
    const first = migrationChecksum({ id: "one", up: "SELECT 1", down: "SELECT 2" });
    const changedUp = migrationChecksum({ id: "one", up: "SELECT 3", down: "SELECT 2" });
    const changedDown = migrationChecksum({ id: "one", up: "SELECT 1", down: "SELECT 4" });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toBe(changedUp);
    expect(first).toBe(changedDown);
    expect(first).not.toContain("SELECT");
  });

  it("binds the separate down checksum only to the ID and exact down SQL", () => {
    const first = migrationDownChecksum({ id: "one", up: "SELECT 1", down: "SELECT 2" });
    const changedUp = migrationDownChecksum({ id: "one", up: "SELECT 3", down: "SELECT 2" });
    const changedDown = migrationDownChecksum({ id: "one", up: "SELECT 1", down: "SELECT 4" });
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toBe(changedUp);
    expect(first).not.toBe(changedDown);
    expect(first).not.toContain("SELECT");
  });
});
