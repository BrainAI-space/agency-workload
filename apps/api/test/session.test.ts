import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AuthService } from "../src/auth-service.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  appOrigin: "http://localhost:3100",
  environment: "test",
  databaseUrl: "unused",
  gotrueOrigin: "http://127.0.0.1:9999",
  gotrueServiceRoleKey: "unused",
  sessionSecret: "s".repeat(64),
  smtp: { host: "127.0.0.1", port: 1025, from: "auth@example.invalid", senderName: "Test" },
};

describe("session expiry", () => {
  it("revokes an idle or absolutely expired opaque session", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            user_id: "22222222-2222-4222-8222-222222222222",
            organization_id: "33333333-3333-4333-8333-333333333333",
            role: "member",
            csrf_hash: Buffer.alloc(32),
            idle_expires_at: new Date("2029-01-01T00:00:00Z"),
            absolute_expires_at: new Date("2029-01-01T00:00:00Z"),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });
    const service = new AuthService(
      { query } as unknown as Pool,
      config,
      {} as never,
      {} as never,
      () => new Date("2030-01-01T00:00:00Z"),
    );
    expect(await service.getSession("opaque-token")).toBeNull();
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain("revoked_at");
  });
});
