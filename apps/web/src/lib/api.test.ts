import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockClear();
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

  it("unassigns holiday calendars through the protected same-origin API", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await api.unassignHolidayCalendar("person-id", "memory-csrf");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/people/person-id/holiday-calendar",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        headers: expect.objectContaining({
          "content-type": "application/json",
          "x-csrf-token": "memory-csrf",
        }),
      }),
    );
  });

  it("forwards cancellation to Start Finder requests", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const controller = new AbortController();
    await api.findEarliestStart(
      {
        notBefore: "2030-01-07",
        workdayCount: 5,
        dailyMinutes: 240,
        scenario: "confirmed",
        horizonDays: 30,
      },
      "memory-csrf",
      controller.signal,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/earliest-start",
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("returns backend continuous allocation safety from Start Finder", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            personId: "44444444-4444-4444-8444-444444444444",
            start: "2030-01-11",
            end: "2030-01-14",
            minimumHeadroomMinutes: 420,
            continuousAllocationSafe: true,
            explanation: "Weekend dates have zero baseline demand.",
          },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const results = await api.findEarliestStart(
      {
        notBefore: "2030-01-11",
        workdayCount: 2,
        dailyMinutes: 60,
        scenario: "confirmed",
        horizonDays: 14,
      },
      "memory-csrf",
    );

    expect(results[0]?.continuousAllocationSafe).toBe(true);
  });
});
