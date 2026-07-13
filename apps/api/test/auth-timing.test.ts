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

describe("request-code enumeration timing", () => {
  it("pads unknown responses to a deterministic minimum plus injected jitter", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const sleep = vi.fn(async () => undefined);
    const monotonic = vi.fn().mockReturnValueOnce(100).mockReturnValueOnce(135);
    const service = new AuthService(
      { query } as unknown as Pool,
      config,
      {} as never,
      {} as never,
      () => new Date("2030-01-01T00:00:00Z"),
      { minimumMs: 150, jitter: () => 10, monotonic, sleep },
    );
    const response = await service.requestCode("unknown@example.com", "198.51.100.4");
    expect(response).toEqual({ message: "If an active account exists, a code will be sent." });
    expect(sleep).toHaveBeenCalledWith(125);
  });

  it("applies the same deterministic padding wrapper to eligible and disabled paths", async () => {
    const makeTiming = () => {
      const sleep = vi.fn(async () => undefined);
      return {
        sleep,
        timing: {
          minimumMs: 150,
          jitter: () => 0,
          monotonic: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(40),
          sleep,
        },
      };
    };
    const disabledTiming = makeTiming();
    const disabled = new AuthService(
      { query: vi.fn(async () => ({ rows: [] })) } as unknown as Pool,
      config,
      {} as never,
      {} as never,
      () => new Date("2030-01-01T00:00:00Z"),
      disabledTiming.timing,
    );
    const eligibleTiming = makeTiming();
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [{ organization_id: "11111111-1111-4111-8111-111111111111" }],
      })
      .mockResolvedValueOnce({ rows: [{ email_count: "0", ip_count: "0", latest: null }] })
      .mockResolvedValueOnce({ rows: [] });
    const eligible = new AuthService(
      { query } as unknown as Pool,
      config,
      {
        ensureUser: vi.fn(async () => ({ id: "identity" })),
        generateEmailOtp: vi.fn(async () => "123456"),
      } as never,
      { sendOtp: vi.fn(async () => undefined) },
      () => new Date("2030-01-01T00:00:00Z"),
      eligibleTiming.timing,
    );
    const [disabledResponse, eligibleResponse] = await Promise.all([
      disabled.requestCode("disabled@example.com", "198.51.100.5"),
      eligible.requestCode("known@example.com", "198.51.100.5"),
    ]);
    expect(disabledResponse).toEqual(eligibleResponse);
    expect(disabledTiming.sleep).toHaveBeenCalledWith(120);
    expect(eligibleTiming.sleep).toHaveBeenCalledWith(120);
  });
});
