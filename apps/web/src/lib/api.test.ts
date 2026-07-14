import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

describe("same-origin API client", () => {
  it("always sends credentials and JSON without persisting CSRF", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await api.logout("memory-csrf");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-csrf-token": "memory-csrf",
        }),
      }),
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("maps allowlisted server errors without exposing response internals", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "last_owner_protected", extra: "ignored" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(api.deactivateMember("id", "csrf")).rejects.toEqual(
      expect.objectContaining({ code: "last_owner_protected", status: 409 }),
    );
  });
});
