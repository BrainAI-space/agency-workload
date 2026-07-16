import type { AppRole } from "@agency-workload/contracts";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import type { SessionContext } from "../src/auth-service.js";
import { HttpError } from "../src/errors.js";
import { PlanningService } from "../src/planning-service.js";
import type { ApplicationServices } from "../src/services.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

function services(role: AppRole): ApplicationServices {
  const session: SessionContext = {
    sessionId,
    userId,
    organizationId,
    role,
    csrfHash: Buffer.alloc(32),
    absoluteExpiresAt: new Date("2030-01-01T00:00:00Z"),
  };
  const requireManage = () => {
    if (!["owner", "admin", "planner"].includes(role)) throw new HttpError(403, "forbidden");
  };
  const planning = {
    listPeople: vi.fn(async () => [
      {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Person",
        email: ["owner", "admin", "planner"].includes(role) ? "work@example.com" : undefined,
        teamId: null,
        deliveryRoleId: null,
        tagIds: [],
        activeFrom: "2030-01-07",
        activeUntil: null,
        rowVersion: 1,
        archivedAt: null,
        unexpected: "must-not-leak",
      },
    ]),
    createPerson: vi.fn(async () => {
      requireManage();
      return {
        id: "44444444-4444-4444-8444-444444444444",
        name: "Person",
        email: "work@example.com",
        teamId: null,
        deliveryRoleId: null,
        tagIds: [],
        activeFrom: "2030-01-07",
        activeUntil: null,
        rowVersion: 1,
        unexpected: "must-not-leak",
      };
    }),
    getPerson: vi.fn(async () => {
      throw new HttpError(404, "person_not_found");
    }),
    updatePerson: vi.fn(async () => {
      throw new HttpError(409, "stale_write");
    }),
    archivePerson: vi.fn(async () => undefined),
    addWorkSchedule: vi.fn(async () => ({})),
    getSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async () => ({})),
    listProjects: vi.fn(async () => [
      {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: "Project",
        kind: "billable",
        status: "confirmed",
        targetStart: null,
        targetEnd: null,
        rowVersion: 1,
        completedAt: null,
        archivedAt: null,
        unexpected: "must-not-leak",
      },
    ]),
    createProject: vi.fn(async (_actor, input) => {
      if (input.targetEnd && !input.targetStart) throw new HttpError(400, "invalid_project_dates");
      return {
        id: "55555555-5555-4555-8555-555555555555",
        clientId: null,
        name: input.name,
        kind: input.kind,
        status: input.status,
        targetStart: input.targetStart ?? null,
        targetEnd: input.targetEnd ?? null,
        rowVersion: 1,
        completedAt: null,
      };
    }),
    getProject: vi.fn(async () => ({})),
    updateProject: vi.fn(async () => ({})),
    archiveProject: vi.fn(async () => undefined),
    completeProject: vi.fn(async () => undefined),
    listAllocations: vi.fn(async () => [
      {
        id: "66666666-6666-4666-8666-666666666666",
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        capacityPercent: null,
        state: "confirmed",
        rowVersion: 1,
        kind: "billable",
        deletedAt: null,
        unexpected: "must-not-leak",
      },
    ]),
    createAllocation: vi.fn(async () => ({})),
    updateAllocation: vi.fn(async () => ({})),
    deleteAllocation: vi.fn(async () => undefined),
    getSchedule: vi.fn(async (_actor, start, end, scenario) => ({
      start,
      end,
      scenario,
      people: [],
      conflicts: [],
      unexpected: "must-not-leak",
    })),
  } as unknown as ApplicationServices["planning"];
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
    planning,
    catalog: {} as ApplicationServices["catalog"],
    calendar: {} as ApplicationServices["calendar"],
    derived: {} as ApplicationServices["derived"],
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

const schedule = Array.from({ length: 7 }, (_, index) => ({
  isoWeekday: index + 1,
  minutes: index < 5 ? 480 : 0,
}));
const personBody = { name: "Person", activeFrom: "2030-01-07", schedule };

describe("planning route boundary", () => {
  it("allows every role to read but only owner/admin/planner to mutate", async () => {
    for (const role of ["owner", "admin", "planner", "member", "viewer"] as const) {
      const app = await appFor(role);
      const listResponse = await app.inject({
        method: "GET",
        url: "/api/v1/people",
        headers: { cookie: "agency_workload_session_dev=session" },
      });
      expect(listResponse.statusCode).toBe(200);
      const listed = listResponse.json()[0] as Record<string, unknown>;
      expect(listed.unexpected).toBeUndefined();
      expect(listed.archivedAt).toBeUndefined();
      if (["owner", "admin", "planner"].includes(role))
        expect(listed.email).toBe("work@example.com");
      else expect(listed.email).toBeUndefined();
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/people",
        headers: {
          cookie: "agency_workload_session_dev=session",
          origin: "http://localhost:3100",
          "content-type": "application/json",
          "x-csrf-token": "csrf",
        },
        payload: personBody,
      });
      expect(response.statusCode).toBe(["owner", "admin", "planner"].includes(role) ? 200 : 403);
    }
  });

  it("serializes schedule responses through an explicit allowlist", async () => {
    const app = await appFor("viewer");
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/schedule?start=2030-01-07&end=2030-01-07&scenario=confirmed",
      headers: { cookie: "agency_workload_session_dev=session" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      start: "2030-01-07",
      end: "2030-01-07",
      scenario: "confirmed",
      people: [],
      conflicts: [],
    });
  });

  it("serializes tentative work categories in schedule days", async () => {
    const service = services("viewer");
    service.planning.getSchedule = vi.fn(async () => ({
      start: "2030-01-07",
      end: "2030-01-07",
      scenario: "confirmed_and_tentative" as const,
      people: [
        {
          personId: "44444444-4444-4444-8444-444444444444",
          days: [
            {
              personId: "44444444-4444-4444-8444-444444444444",
              date: "2030-01-07",
              scheduledMinutes: 480,
              leaveMinutes: 0,
              capacityMinutes: 480,
              confirmedMinutes: 120,
              tentativeMinutes: 90,
              tentativeBillableMinutes: 60,
              tentativeInternalMinutes: 30,
              billableConfirmedMinutes: 120,
              internalConfirmedMinutes: 0,
              availableConfirmedMinutes: 360,
              availableScenarioMinutes: 270,
              confirmedOverbookMinutes: 0,
              potentialOverbookMinutes: 0,
              billableUtilizationPercent: 25,
              internalUtilizationPercent: 0,
              unexpected: "must-not-leak",
            },
          ],
        },
      ],
      conflicts: [],
    }));
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/schedule?start=2030-01-07&end=2030-01-07&scenario=confirmed_and_tentative",
      headers: { cookie: "agency_workload_session_dev=session" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().people[0].days[0]).toMatchObject({
      tentativeBillableMinutes: 60,
      tentativeInternalMinutes: 30,
    });
    expect(response.json().people[0].days[0]).not.toHaveProperty("unexpected");
  });

  it("serializes project and allocation lists without lifecycle or unexpected fields", async () => {
    const app = await appFor("viewer");
    const headers = { cookie: "agency_workload_session_dev=session" };
    const projects = (
      await app.inject({ method: "GET", url: "/api/v1/projects", headers })
    ).json()[0] as Record<string, unknown>;
    expect(projects.archivedAt).toBeUndefined();
    expect(projects.unexpected).toBeUndefined();
    const allocations = (
      await app.inject({ method: "GET", url: "/api/v1/allocations", headers })
    ).json()[0] as Record<string, unknown>;
    expect(allocations.deletedAt).toBeUndefined();
    expect(allocations.unexpected).toBeUndefined();
  });

  it("enforces CSRF, exact schemas, cross-organization 404, and stale-write 409", async () => {
    const app = await appFor("owner");
    const headers = {
      cookie: "agency_workload_session_dev=session",
      origin: "http://localhost:3100",
      "content-type": "application/json",
    };
    expect(
      (await app.inject({ method: "POST", url: "/api/v1/people", headers, payload: personBody }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/people",
          headers: { ...headers, "x-csrf-token": "csrf" },
          payload: { ...personBody, unknown: true },
        })
      ).statusCode,
    ).toBe(400);
    const id = "44444444-4444-4444-8444-444444444444";
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/people/${id}`,
          headers: { cookie: "agency_workload_session_dev=session" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/people/${id}`,
          headers: { ...headers, "x-csrf-token": "csrf" },
          payload: { name: "Person", activeFrom: "2030-01-07", rowVersion: 1 },
        })
      ).statusCode,
    ).toBe(409);
  });

  it("serializes complete person updates including tag IDs", async () => {
    const service = services("owner");
    service.planning.updatePerson = vi.fn(async () => ({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Updated Person",
      email: "work@example.com",
      teamId: null,
      deliveryRoleId: null,
      tagIds: ["77777777-7777-4777-8777-777777777777"],
      activeFrom: "2030-01-07",
      activeUntil: null,
      rowVersion: 2,
      unexpected: "must-not-leak",
    }));
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/people/44444444-4444-4444-8444-444444444444",
      headers: {
        cookie: "agency_workload_session_dev=session",
        origin: "http://localhost:3100",
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      },
      payload: {
        name: "Updated Person",
        activeFrom: "2030-01-07",
        tagIds: ["77777777-7777-4777-8777-777777777777"],
        rowVersion: 1,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      id: "44444444-4444-4444-8444-444444444444",
      name: "Updated Person",
      email: "work@example.com",
      teamId: null,
      deliveryRoleId: null,
      tagIds: ["77777777-7777-4777-8777-777777777777"],
      activeFrom: "2030-01-07",
      activeUntil: null,
      rowVersion: 2,
    });
  });

  it("maps invalid civil dates and IANA timezones to stable 400 errors", async () => {
    const service = services("owner");
    service.planning = new PlanningService({} as Pool);
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const invalidDate = await app.inject({
      method: "GET",
      url: "/api/v1/schedule?start=2030-02-30&end=2030-03-01&scenario=confirmed",
      headers: { cookie: "agency_workload_session_dev=session" },
    });
    expect(invalidDate.statusCode).toBe(400);
    expect(invalidDate.json()).toEqual({ error: "invalid_calendar_date" });

    for (const query of ["start=2030-02-30", "end=2030-02-30"]) {
      const invalidAllocationBoundary = await app.inject({
        method: "GET",
        url: `/api/v1/allocations?${query}`,
        headers: { cookie: "agency_workload_session_dev=session" },
      });
      expect(invalidAllocationBoundary.statusCode).toBe(400);
      expect(invalidAllocationBoundary.json()).toEqual({ error: "invalid_calendar_date" });
    }

    const invalidTimezone = await app.inject({
      method: "PATCH",
      url: "/api/v1/planning/settings",
      headers: {
        cookie: "agency_workload_session_dev=session",
        origin: "http://localhost:3100",
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      },
      payload: {
        timezone: "Mars/Olympus_Mons",
        weekStartsOn: 1,
        dateFormat: "YYYY-MM-DD",
        forecastHorizonWeeks: 13,
        billableTargetPercent: 75,
        rowVersion: 1,
      },
    });
    expect(invalidTimezone.statusCode).toBe(400);
    expect(invalidTimezone.json()).toEqual({ error: "invalid_timezone" });
  });

  it("bounds default forecast settings to 13 through 52 weeks", async () => {
    const app = await appFor("owner");
    const headers = {
      cookie: "agency_workload_session_dev=session",
      origin: "http://localhost:3100",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    };
    for (const forecastHorizonWeeks of [12, 53]) {
      const response = await app.inject({
        method: "PATCH",
        url: "/api/v1/planning/settings",
        headers,
        payload: {
          timezone: "UTC",
          weekStartsOn: 1,
          dateFormat: "YYYY-MM-DD",
          forecastHorizonWeeks,
          billableTargetPercent: 75,
          rowVersion: 1,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_request" });
    }
  });

  it("maps stale settings writes and invalid project transitions to stable 409 errors", async () => {
    const service = services("owner");
    service.planning.updateSettings = vi.fn(async () => {
      throw new HttpError(409, "stale_write");
    });
    service.planning.completeProject = vi.fn(async () => {
      throw new HttpError(409, "invalid_project_transition");
    });
    service.planning.updateProject = vi.fn(async () => {
      throw new HttpError(409, "invalid_project_transition");
    });
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const headers = {
      cookie: "agency_workload_session_dev=session",
      origin: "http://localhost:3100",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    };

    const settings = await app.inject({
      method: "PATCH",
      url: "/api/v1/planning/settings",
      headers,
      payload: {
        timezone: "UTC",
        weekStartsOn: 1,
        dateFormat: "YYYY-MM-DD",
        forecastHorizonWeeks: 13,
        billableTargetPercent: 75,
        rowVersion: 1,
      },
    });
    expect(settings.statusCode).toBe(409);
    expect(settings.json()).toEqual({ error: "stale_write" });

    const update = await app.inject({
      method: "PATCH",
      url: "/api/v1/projects/55555555-5555-4555-8555-555555555555",
      headers,
      payload: {
        name: "Terminal project",
        kind: "billable",
        status: "draft",
        rowVersion: 2,
      },
    });
    expect(update.statusCode).toBe(409);
    expect(update.json()).toEqual({ error: "invalid_project_transition" });

    const transition = await app.inject({
      method: "POST",
      url: "/api/v1/projects/55555555-5555-4555-8555-555555555555/complete",
      headers,
      payload: { rowVersion: 2 },
    });
    expect(transition.statusCode).toBe(409);
    expect(transition.json()).toEqual({ error: "invalid_project_transition" });
  });

  it("rejects whitespace-only people and project names at the contract boundary", async () => {
    const app = await appFor("owner");
    const headers = {
      cookie: "agency_workload_session_dev=session",
      origin: "http://localhost:3100",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    };
    const person = await app.inject({
      method: "POST",
      url: "/api/v1/people",
      headers,
      payload: { ...personBody, name: "   " },
    });
    expect(person.statusCode).toBe(400);
    const project = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: { name: "\t ", kind: "billable", status: "draft" },
    });
    expect(project.statusCode).toBe(400);
  });

  it("validates schedule query date and scenario shapes", async () => {
    const app = await appFor("viewer");
    const cookie = { cookie: "agency_workload_session_dev=session" };
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/schedule?start=2030-01-07&end=2030-01-31&scenario=confirmed",
          headers: cookie,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/v1/schedule?start=2030-1-7&end=2030-01-31&scenario=wrong",
          headers: cookie,
        })
      ).statusCode,
    ).toBe(400);
  });

  it("returns API-safe project date and allocation-state errors", async () => {
    const service = services("planner");
    service.planning.createAllocation = vi.fn(async () => {
      throw new HttpError(409, "project_not_allocatable");
    });
    const app = await buildApp({
      logger: false,
      config: { appOrigin: "http://localhost:3100", environment: "test" },
      services: service,
    });
    apps.push(app);
    const headers = {
      cookie: "agency_workload_session_dev=session",
      origin: "http://localhost:3100",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    };
    const invalidDates = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers,
      payload: {
        name: "Invalid",
        kind: "billable",
        status: "draft",
        targetEnd: "2030-01-31",
      },
    });
    expect(invalidDates.statusCode).toBe(400);
    expect(invalidDates.json()).toEqual({ error: "invalid_project_dates" });

    const unavailable = await app.inject({
      method: "POST",
      url: "/api/v1/allocations",
      headers,
      payload: {
        personId: "44444444-4444-4444-8444-444444444444",
        projectId: "55555555-5555-4555-8555-555555555555",
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        state: "confirmed",
      },
    });
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toEqual({ error: "project_not_allocatable" });
  });
});
