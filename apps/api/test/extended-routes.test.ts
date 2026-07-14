import type { AppRole } from "@agency-workload/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { SessionContext } from "../src/auth-service.js";
import type { CatalogKind } from "../src/catalog-service.js";
import { HttpError } from "../src/errors.js";
import type { ApplicationServices } from "../src/services.js";

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));
const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";

function services(role: AppRole): ApplicationServices {
  const session: SessionContext = {
    sessionId: "44444444-4444-4444-8444-444444444444",
    userId,
    organizationId,
    role,
    csrfHash: Buffer.alloc(32),
    absoluteExpiresAt: new Date("2031-01-01T00:00:00Z"),
  };
  const structure = () => {
    if (!["owner", "admin"].includes(role)) throw new HttpError(403, "forbidden");
  };
  const planner = () => {
    if (!["owner", "admin", "planner"].includes(role)) throw new HttpError(403, "forbidden");
  };
  return {
    auth: {
      getSession: vi.fn(async () => session),
      verifyCsrf: vi.fn((_session, token) => token === "csrf"),
      csrfToken: vi.fn(() => "csrf"),
      requestCode: vi.fn(),
      verifyCode: vi.fn(),
      logout: vi.fn(),
    },
    admin: {} as ApplicationServices["admin"],
    planning: {} as ApplicationServices["planning"],
    catalog: {
      list: vi.fn(async () => [{ id: itemId, name: "Delivery", rowVersion: 1, secret: "drop" }]),
      create: vi.fn(async () => {
        structure();
        return { id: itemId, name: "Delivery", rowVersion: 1, secret: "drop" };
      }),
      update: vi.fn(async () => ({ id: itemId, name: "Delivery", rowVersion: 2 })),
      archive: vi.fn(async () => undefined),
      listClients: vi.fn(async () => []),
      createClient: vi.fn(async () => {
        planner();
        return { id: itemId, name: "Client", rowVersion: 1 };
      }),
      updateClient: vi.fn(async () => ({})),
      archiveClient: vi.fn(async () => undefined),
    } as unknown as ApplicationServices["catalog"],
    calendar: {
      listHolidayCalendars: vi.fn(async () => []),
      listLeaveTypes: vi.fn(async () => []),
      listLeave: vi.fn(async () =>
        role === "viewer"
          ? [{ id: itemId, personId: itemId, startDate: "2030-01-07", endDate: "2030-01-07" }]
          : [
              {
                id: itemId,
                personId: itemId,
                leaveTypeId: itemId,
                leaveTypeName: "Vacation",
                startDate: "2030-01-07",
                endDate: "2030-01-07",
                minutesPerDay: null,
                rowVersion: 1,
              },
            ],
      ),
      createHolidayCalendar: vi.fn(async () => {
        structure();
        return { id: itemId, name: "Calendar", rowVersion: 1 };
      }),
      updateHolidayCalendar: vi.fn(async () => {
        structure();
        return { id: itemId, name: "Calendar", rowVersion: 2 };
      }),
      archiveHolidayCalendar: vi.fn(async () => structure()),
      addHolidayDate: vi.fn(async () => {
        structure();
        return { date: "2030-01-07", name: "Holiday" };
      }),
      removeHolidayDate: vi.fn(async () => structure()),
      assignHolidayCalendar: vi.fn(async () => structure()),
      createLeaveType: vi.fn(async () => ({})),
      updateLeaveType: vi.fn(async () => ({})),
      archiveLeaveType: vi.fn(async () => undefined),
      createLeave: vi.fn(async () => {
        if (role === "viewer") throw new HttpError(404, "leave_not_found");
        return {
          id: itemId,
          personId: itemId,
          leaveTypeId: itemId,
          startDate: "2030-01-07",
          endDate: "2030-01-07",
          minutesPerDay: null,
          rowVersion: 1,
        };
      }),
      updateLeave: vi.fn(async () => ({})),
      deleteLeave: vi.fn(async () => undefined),
    } as unknown as ApplicationServices["calendar"],
    derived: {
      listConflicts: vi.fn(async () => []),
      acknowledge: vi.fn(async () => {
        planner();
      }),
      unacknowledge: vi.fn(async () => undefined),
      earliestStart: vi.fn(async () => []),
      forecast: vi.fn(async () => ({
        generatedAt: "2030-01-07T00:00:00.000Z",
        timezone: "UTC",
        weekStartsOn: 1,
        assumptions: "Advisory",
        weeks: [],
      })),
    } as unknown as ApplicationServices["derived"],
    close: vi.fn(async () => undefined),
  };
}

async function appFor(role: AppRole) {
  const app = await buildApp({
    logger: false,
    config: { appOrigin: "http://localhost:3100", environment: "test" },
    services: services(role),
  });
  apps.push(app);
  return app;
}

const authHeaders = { cookie: "agency_workload_session_dev=session" };
const mutationHeaders = {
  ...authHeaders,
  origin: "http://localhost:3100",
  "content-type": "application/json",
  "x-csrf-token": "csrf",
};

describe("deferred V1 route role and serialization matrix", () => {
  it("allows all roles to read catalogs and strips unexpected response fields", async () => {
    for (const role of ["owner", "admin", "planner", "member", "viewer"] as const) {
      const app = await appFor(role);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/teams",
        headers: authHeaders,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([{ id: itemId, name: "Delivery", rowVersion: 1 }]);
    }
  });

  it("limits structural catalog mutation to owner/admin and client mutation to planners", async () => {
    for (const role of ["owner", "admin", "planner", "member", "viewer"] as const) {
      const app = await appFor(role);
      const team = await app.inject({
        method: "POST",
        url: "/api/v1/teams",
        headers: mutationHeaders,
        payload: { name: "Delivery" },
      });
      expect(team.statusCode).toBe(["owner", "admin"].includes(role) ? 200 : 403);
      const client = await app.inject({
        method: "POST",
        url: "/api/v1/clients",
        headers: mutationHeaders,
        payload: { name: "Client" },
      });
      expect(client.statusCode).toBe(["owner", "admin", "planner"].includes(role) ? 200 : 403);
    }
  });

  it("limits every holiday calendar structure mutation to owner/admin", async () => {
    for (const role of ["owner", "admin", "planner", "member", "viewer"] as const) {
      const app = await appFor(role);
      const requests = [
        { method: "POST", url: "/api/v1/holiday-calendars", payload: { name: "Calendar" } },
        {
          method: "PATCH",
          url: `/api/v1/holiday-calendars/${itemId}`,
          payload: { name: "Calendar", rowVersion: 1 },
        },
        {
          method: "POST",
          url: `/api/v1/holiday-calendars/${itemId}/archive`,
          payload: { rowVersion: 1 },
        },
        {
          method: "POST",
          url: `/api/v1/holiday-calendars/${itemId}/dates`,
          payload: { date: "2030-01-07", name: "Holiday" },
        },
        {
          method: "DELETE",
          url: `/api/v1/holiday-calendars/${itemId}/dates/2030-01-07`,
          payload: {},
        },
        {
          method: "PUT",
          url: `/api/v1/people/${itemId}/holiday-calendar`,
          payload: { calendarId: itemId },
        },
      ] as const;
      for (const request of requests) {
        const response = await app.inject({ ...request, headers: mutationHeaders });
        expect(response.statusCode).toBe(["owner", "admin"].includes(role) ? 200 : 403);
      }
    }
  });

  it("returns stable duplicate conflict codes from service errors", async () => {
    const service = services("owner");
    service.catalog.create = vi.fn(async (_actor, kind: CatalogKind) => {
      const codes = {
        teams: "team_name_conflict",
        delivery_roles: "delivery_role_name_conflict",
        tags: "tag_name_conflict",
      } as const;
      throw new HttpError(409, codes[kind]);
    });
    service.catalog.createClient = vi.fn(async () => {
      throw new HttpError(409, "client_name_conflict");
    });
    service.calendar.createHolidayCalendar = vi.fn(async () => {
      throw new HttpError(409, "holiday_calendar_name_conflict");
    });
    service.calendar.createLeaveType = vi.fn(async () => {
      throw new HttpError(409, "leave_type_name_conflict");
    });
    service.calendar.addHolidayDate = vi.fn(async () => {
      throw new HttpError(409, "holiday_date_conflict");
    });
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const cases = [
      ["/api/v1/teams", { name: "Duplicate" }, "team_name_conflict"],
      ["/api/v1/delivery-roles", { name: "Duplicate" }, "delivery_role_name_conflict"],
      ["/api/v1/tags", { name: "Duplicate" }, "tag_name_conflict"],
      ["/api/v1/clients", { name: "Duplicate" }, "client_name_conflict"],
      ["/api/v1/holiday-calendars", { name: "Duplicate" }, "holiday_calendar_name_conflict"],
      ["/api/v1/leave-types", { name: "Duplicate" }, "leave_type_name_conflict"],
      [
        `/api/v1/holiday-calendars/${itemId}/dates`,
        { date: "2030-01-07", name: "Duplicate" },
        "holiday_date_conflict",
      ],
    ] as const;
    for (const [url, payload, code] of cases) {
      const response = await app.inject({ method: "POST", url, headers: mutationHeaders, payload });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ error: code });
    }
  });

  it("redacts viewer leave details and rejects viewer mutation non-enumerating", async () => {
    const app = await appFor("viewer");
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/leave?start=2030-01-01&end=2030-01-31",
      headers: authHeaders,
    });
    expect(list.json()[0]).toEqual({
      id: itemId,
      personId: itemId,
      startDate: "2030-01-07",
      endDate: "2030-01-07",
    });
    const mutation = await app.inject({
      method: "POST",
      url: "/api/v1/leave",
      headers: mutationHeaders,
      payload: {
        personId: itemId,
        leaveTypeId: itemId,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
      },
    });
    expect(mutation.statusCode).toBe(404);
  });

  it("keeps member foreign leave update/delete non-enumerating", async () => {
    const service = services("member");
    service.calendar.updateLeave = vi.fn(async () => {
      throw new HttpError(404, "leave_not_found");
    });
    service.calendar.deleteLeave = vi.fn(async () => {
      throw new HttpError(404, "leave_not_found");
    });
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const update = await app.inject({
      method: "PATCH",
      url: `/api/v1/leave/${itemId}`,
      headers: mutationHeaders,
      payload: {
        personId: itemId,
        leaveTypeId: itemId,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        rowVersion: 1,
      },
    });
    expect(update.statusCode).toBe(404);
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/leave/${itemId}`,
      headers: mutationHeaders,
      payload: { rowVersion: 1 },
    });
    expect(deletion.statusCode).toBe(404);
  });

  it("requires CSRF and planner authority for acknowledgements", async () => {
    const fingerprint = "12345678abcdef00";
    const planner = await appFor("planner");
    expect(
      (
        await planner.inject({
          method: "POST",
          url: `/api/v1/conflicts/${fingerprint}/acknowledge`,
          headers: {
            cookie: "agency_workload_session_dev=session",
            origin: "http://localhost:3100",
            "content-type": "application/json",
          },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await planner.inject({
          method: "POST",
          url: `/api/v1/conflicts/${fingerprint}/acknowledge`,
          headers: mutationHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    const memberApp = await appFor("member");
    expect(
      (
        await memberApp.inject({
          method: "POST",
          url: `/api/v1/conflicts/${fingerprint}/acknowledge`,
          headers: mutationHeaders,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it("bounds earliest and forecast input schemas", async () => {
    const app = await appFor("viewer");
    const invalidEarliest = await app.inject({
      method: "POST",
      url: "/api/v1/earliest-start",
      headers: mutationHeaders,
      payload: {
        notBefore: "2030-01-07",
        workdayCount: 61,
        dailyMinutes: 60,
        scenario: "confirmed",
        horizonDays: 365,
      },
    });
    expect(invalidEarliest.statusCode).toBe(400);
    const invalidForecast = await app.inject({
      method: "GET",
      url: "/api/v1/forecast?weeks=53",
      headers: authHeaders,
    });
    expect(invalidForecast.statusCode).toBe(400);
  });
});
