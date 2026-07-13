import { describe, expect, it } from "vitest";
import { assertDownMigrationAllowed } from "../src/migration-policy.js";

describe("down migration policy", () => {
  it("requires explicit confirmation", () => {
    expect(() => assertDownMigrationAllowed(["--down"], { APP_ENV: "development" })).toThrow(
      /confirm-down/,
    );
    expect(() =>
      assertDownMigrationAllowed(["--down", "--confirm-down"], { APP_ENV: "development" }),
    ).not.toThrow();
  });

  it("requires separate production break-glass confirmation", () => {
    expect(() =>
      assertDownMigrationAllowed(["--down", "--confirm-down"], { APP_ENV: "production" }),
    ).toThrow(/break-glass-production/);
    expect(() =>
      assertDownMigrationAllowed(["--down", "--confirm-down", "--break-glass-production"], {
        APP_ENV: "production",
      }),
    ).not.toThrow();
  });
});
