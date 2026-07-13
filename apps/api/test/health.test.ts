import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("health endpoint", () => {
  it("returns a minimal no-store response with a request identifier", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.json()).toEqual({ status: "ok" });
  });

  it("does not expose framework or server implementation headers", async () => {
    const app = await buildApp({ logger: false });
    apps.push(app);

    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
  });
});
