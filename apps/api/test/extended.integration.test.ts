import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  assertExactPostgresIntegrationBoundary,
  runDisposablePostgresSql,
} from "../../../tools/lib/postgres-integration-boundary.mjs";
import type { SessionContext } from "../src/auth-service.js";
import { CalendarService } from "../src/calendar-service.js";
import { CatalogService } from "../src/catalog-service.js";
import { DerivedService } from "../src/derived-service.js";
import { PlanningService } from "../src/planning-service.js";
import { runRowLockRace } from "./row-lock-race.js";

const enabled = process.env.AW_EXTENDED_INTEGRATION === "1";
if (enabled) assertExactPostgresIntegrationBoundary(process.env, "extended");
const pool = enabled ? new Pool({ connectionString: process.env.DATABASE_URL, max: 8 }) : null;
const suffix = randomBytes(5).toString("hex");
let organizationId = "";
let secondOrganizationId = "";
let ownerUserId = "";
let memberUserId = "";
let owner: SessionContext;
let member: SessionContext;
let viewer: SessionContext;
let catalog: CatalogService;
let calendar: CalendarService;
let planning: PlanningService;
let derived: DerivedService;

function db(): Pool {
  if (!pool) throw new Error("extended integration pool unavailable");
  return pool;
}

function context(
  userId: string,
  role: SessionContext["role"],
  organization = organizationId,
): SessionContext {
  return {
    sessionId: randomUUID(),
    userId,
    organizationId: organization,
    role,
    csrfHash: Buffer.alloc(32),
    absoluteExpiresAt: new Date("2031-01-01T00:00:00Z"),
  };
}

function superuserSql(sql: string): void {
  runDisposablePostgresSql(process.env, "extended", sql);
}

const week = Array.from({ length: 7 }, (_, index) => ({
  isoWeekday: index + 1,
  minutes: index < 5 ? 480 : 0,
}));

describe.skipIf(!enabled)("deferred V1 APIs PostgreSQL integration", () => {
  beforeAll(async () => {
    organizationId = randomUUID();
    secondOrganizationId = randomUUID();
    ownerUserId = randomUUID();
    memberUserId = randomUUID();
    superuserSql(`
      INSERT INTO app.organizations (id, slug, name)
      VALUES ('${organizationId}', 'extended-${suffix}', 'Extended'),
             ('${secondOrganizationId}', 'extended-other-${suffix}', 'Other');
      INSERT INTO app.users (id, gotrue_user_id, email)
      VALUES ('${ownerUserId}', '${randomUUID()}', 'extended-owner-${suffix}@example.invalid'),
             ('${memberUserId}', '${randomUUID()}', 'extended-member-${suffix}@example.invalid');
    `);
    owner = context(ownerUserId, "owner");
    member = context(memberUserId, "member");
    viewer = context(randomUUID(), "viewer");
    catalog = new CatalogService(db());
    calendar = new CalendarService(db());
    planning = new PlanningService(db(), () => new Date("2030-01-07T12:00:00Z"));
    derived = new DerivedService(db(), () => new Date("2030-01-07T12:00:00Z"));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("manages catalogs with uniqueness, stale versions, role matrix, and archived assignment guard", async () => {
    const team = await catalog.create(owner, "teams", "Delivery");
    const role = await catalog.create(owner, "delivery_roles", "Engineer");
    const tag = await catalog.create(owner, "tags", "TypeScript");
    expect(await catalog.list(viewer, "teams")).toHaveLength(1);
    await expect(
      catalog.create(context(ownerUserId, "planner"), "teams", "Other"),
    ).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(catalog.create(owner, "teams", "delivery")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "team_name_conflict",
    });
    await expect(catalog.create(owner, "delivery_roles", "engineer")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "delivery_role_name_conflict",
    });
    await expect(catalog.create(owner, "tags", "typescript")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "tag_name_conflict",
    });
    const secondTeam = await catalog.create(owner, "teams", "Second Team");
    await expect(
      catalog.update(owner, "teams", secondTeam.id, "delivery", secondTeam.rowVersion),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "team_name_conflict" });
    const secondRole = await catalog.create(owner, "delivery_roles", "Second Role");
    await expect(
      catalog.update(owner, "delivery_roles", secondRole.id, "engineer", secondRole.rowVersion),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "delivery_role_name_conflict" });
    const secondTag = await catalog.create(owner, "tags", "Second Tag");
    await expect(
      catalog.update(owner, "tags", secondTag.id, "typescript", secondTag.rowVersion),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "tag_name_conflict" });
    const updated = await catalog.update(
      owner,
      "teams",
      team.id,
      "Client Delivery",
      team.rowVersion,
    );
    await expect(
      catalog.update(owner, "teams", team.id, "Stale", team.rowVersion),
    ).rejects.toMatchObject({
      publicCode: "stale_write",
    });
    const person = await planning.createPerson(
      owner,
      {
        name: "Catalog Person",
        activeFrom: "2030-01-07",
        teamId: updated.id,
        deliveryRoleId: role.id,
        tagIds: [tag.id],
      },
      week,
    );
    await catalog.archive(owner, "teams", updated.id, updated.rowVersion);
    expect(await catalog.list(owner, "teams")).toHaveLength(1);
    await expect(
      planning.createPerson(
        owner,
        { name: "Invalid Team", activeFrom: "2030-01-07", teamId: updated.id },
        week,
      ),
    ).rejects.toMatchObject({ publicCode: "team_not_found" });
    expect((await planning.getPerson(owner, person.id)).teamId).toBe(updated.id);
  });

  it("manages clients and guards archive while active projects reference them", async () => {
    const client = await catalog.createClient(context(ownerUserId, "planner"), "Example Client");
    await expect(catalog.createClient(owner, "example client")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "client_name_conflict",
    });
    const secondClient = await catalog.createClient(owner, "Second Client");
    await expect(
      catalog.updateClient(owner, secondClient.id, "example client", secondClient.rowVersion),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "client_name_conflict" });
    expect(await catalog.listClients(member)).toHaveLength(2);
    const project = await planning.createProject(owner, {
      name: "Client Project",
      kind: "billable",
      status: "confirmed",
      clientId: client.id,
    });
    await expect(catalog.archiveClient(owner, client.id, client.rowVersion)).rejects.toMatchObject({
      publicCode: "active_projects_reference_client",
    });
    const changed = await planning.updateProject(owner, project.id, {
      name: project.name,
      kind: project.kind,
      status: "confirmed",
      clientId: null,
      rowVersion: project.rowVersion,
    });
    void changed;
    await expect(catalog.archiveClient(owner, client.id, 999)).rejects.toMatchObject({
      publicCode: "stale_write",
    });
    await catalog.archiveClient(owner, client.id, client.rowVersion);
    expect(await catalog.listClients(owner)).toHaveLength(1);
  });

  it("serializes client archive with project create and update without deadlock", async () => {
    const assertSerialized = (results: PromiseSettledResult<unknown>[]) => {
      expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (!rejected) throw new Error("client/project race rejection unavailable");
      const error = rejected.reason as {
        code?: unknown;
        publicCode?: unknown;
        statusCode?: unknown;
      };
      expect(error.code).not.toBe("40P01");
      expect(["active_projects_reference_client", "client_not_active"]).toContain(error.publicCode);
      expect(error.statusCode).toBe(409);
    };
    const assertInvariant = async (clientId: string) => {
      const state = await db().query<{ archived: boolean; active_projects: string }>(
        `SELECT client.archived_at IS NOT NULL AS archived,
                count(project.id) FILTER (
                  WHERE project.archived_at IS NULL AND project.status NOT IN ('completed', 'cancelled')
                )::text AS active_projects
         FROM app.clients client
         LEFT JOIN app.projects project
           ON project.organization_id = client.organization_id AND project.client_id = client.id
         WHERE client.organization_id = $1 AND client.id = $2
         GROUP BY client.organization_id, client.id`,
        [organizationId, clientId],
      );
      const row = state.rows[0];
      if (!row) throw new Error("client concurrency state unavailable");
      expect(row.archived && Number(row.active_projects) > 0).toBe(false);
    };

    const createClient = await catalog.createClient(owner, "Concurrency Create Client");
    const createResults = await runRowLockRace({
      pool: db(),
      schema: "app",
      table: "clients",
      organizationId,
      rowId: createClient.id,
      operations: [
        () =>
          planning.createProject(owner, {
            name: "Concurrency Race Create Project",
            kind: "billable",
            status: "confirmed",
            clientId: createClient.id,
          }),
        () => catalog.archiveClient(owner, createClient.id, createClient.rowVersion),
      ],
    });
    assertSerialized(createResults);
    await assertInvariant(createClient.id);

    const updateClient = await catalog.createClient(owner, "Concurrency Update Client");
    const updateProject = await planning.createProject(owner, {
      name: "Update Base Project",
      kind: "billable",
      status: "draft",
    });
    const updateResults = await runRowLockRace({
      pool: db(),
      schema: "app",
      table: "clients",
      organizationId,
      rowId: updateClient.id,
      operations: [
        () =>
          planning.updateProject(owner, updateProject.id, {
            name: "Concurrency Race Update Project",
            kind: "billable",
            status: "confirmed",
            clientId: updateClient.id,
            rowVersion: updateProject.rowVersion,
          }),
        () => catalog.archiveClient(owner, updateClient.id, updateClient.rowVersion),
      ],
    });
    assertSerialized(updateResults);
    await assertInvariant(updateClient.id);
  });

  it("applies holidays and leave immediately with member-own and viewer-redacted access", async () => {
    const role = (await catalog.list(owner, "delivery_roles"))[0];
    const person = await planning.createPerson(
      owner,
      { name: "Leave Person", activeFrom: "2030-01-07", deliveryRoleId: role?.id },
      week,
    );
    await db().query(
      `INSERT INTO app.memberships (organization_id, user_id, role, linked_person_id)
       VALUES ($1, $2, 'member', $3)`,
      [organizationId, memberUserId, person.id],
    );
    await expect(
      calendar.createHolidayCalendar(context(ownerUserId, "planner"), "Denied"),
    ).rejects.toMatchObject({ statusCode: 403 });
    const holiday = await calendar.createHolidayCalendar(owner, "Local Holidays");
    await expect(calendar.createHolidayCalendar(owner, "local holidays")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "holiday_calendar_name_conflict",
    });
    const secondCalendar = await calendar.createHolidayCalendar(owner, "Second Calendar");
    await expect(
      calendar.updateHolidayCalendar(
        owner,
        secondCalendar.id,
        "local holidays",
        secondCalendar.rowVersion,
      ),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "holiday_calendar_name_conflict" });
    await calendar.addHolidayDate(owner, holiday.id, "2030-01-08", "Holiday");
    await expect(
      calendar.addHolidayDate(owner, holiday.id, "2030-01-08", "Duplicate"),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "holiday_date_conflict" });
    await calendar.assignHolidayCalendar(owner, person.id, holiday.id);
    const leaveType = await calendar.createLeaveType(owner, "Vacation");
    await expect(calendar.createLeaveType(owner, "vacation")).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "leave_type_name_conflict",
    });
    const secondLeaveType = await calendar.createLeaveType(owner, "Second Leave Type");
    await expect(
      calendar.updateLeaveType(owner, secondLeaveType.id, "vacation", secondLeaveType.rowVersion),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "leave_type_name_conflict" });
    const leave = await calendar.createLeave(member, {
      personId: person.id,
      leaveTypeId: leaveType.id,
      startDate: "2030-01-09",
      endDate: "2030-01-09",
      minutesPerDay: 120,
    });
    const project = await planning.createProject(owner, {
      name: "Capacity Project",
      kind: "billable",
      status: "confirmed",
    });
    await planning.createAllocation(owner, {
      personId: person.id,
      projectId: project.id,
      startDate: "2030-01-08",
      endDate: "2030-01-09",
      mode: "minutes_per_day",
      minutesPerDay: 300,
      state: "confirmed",
    });
    const schedule = await planning.getSchedule(owner, "2030-01-08", "2030-01-09", "confirmed");
    const leavePersonSchedule = schedule.people.find((entry) => entry.personId === person.id);
    expect(leavePersonSchedule?.days[0]).toMatchObject({
      capacityMinutes: 0,
      confirmedOverbookMinutes: 300,
    });
    expect(leavePersonSchedule?.days[1]).toMatchObject({
      capacityMinutes: 360,
      confirmedMinutes: 300,
    });
    await expect(
      calendar.archiveHolidayCalendar(owner, holiday.id, holiday.rowVersion),
    ).rejects.toMatchObject({
      statusCode: 409,
      publicCode: "holiday_calendar_assigned",
    });
    const whileAssigned = await planning.getSchedule(
      owner,
      "2030-01-08",
      "2030-01-08",
      "confirmed",
    );
    expect(
      whileAssigned.people.find((entry) => entry.personId === person.id)?.days[0],
    ).toMatchObject({
      capacityMinutes: 0,
      confirmedOverbookMinutes: 300,
    });
    await expect(
      calendar.unassignHolidayCalendar(context(ownerUserId, "planner"), person.id),
    ).rejects.toMatchObject({ statusCode: 403 });
    await calendar.unassignHolidayCalendar(owner, person.id);
    await calendar.archiveHolidayCalendar(owner, holiday.id, holiday.rowVersion);
    const afterArchive = await planning.getSchedule(owner, "2030-01-08", "2030-01-08", "confirmed");
    expect(
      afterArchive.people.find((entry) => entry.personId === person.id)?.days[0],
    ).toMatchObject({
      capacityMinutes: 480,
      confirmedMinutes: 300,
      confirmedOverbookMinutes: 0,
    });
    const preservedArchivedCalendar = await db().query<{ calendars: string; dates: string }>(
      `SELECT
         (SELECT count(*)::text FROM app.holiday_calendars WHERE organization_id = $1 AND id = $2) AS calendars,
         (SELECT count(*)::text FROM app.holiday_dates WHERE organization_id = $1 AND calendar_id = $2) AS dates`,
      [organizationId, holiday.id],
    );
    expect(preservedArchivedCalendar.rows[0]).toEqual({ calendars: "1", dates: "1" });

    const archivedPerson = await planning.createPerson(
      owner,
      { name: "Archived Calendar Person", activeFrom: "2020-01-01", activeUntil: "2020-12-31" },
      week,
    );
    const archivedPersonCalendar = await calendar.createHolidayCalendar(
      owner,
      "Archived Person Calendar",
    );
    await calendar.assignHolidayCalendar(owner, archivedPerson.id, archivedPersonCalendar.id);
    await planning.archivePerson(owner, archivedPerson.id, archivedPerson.rowVersion);
    await expect(
      calendar.archiveHolidayCalendar(
        owner,
        archivedPersonCalendar.id,
        archivedPersonCalendar.rowVersion,
      ),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "holiday_calendar_assigned" });
    await calendar.unassignHolidayCalendar(owner, archivedPerson.id);
    await calendar.archiveHolidayCalendar(
      owner,
      archivedPersonCalendar.id,
      archivedPersonCalendar.rowVersion,
    );

    const noAssignmentPerson = await planning.createPerson(
      owner,
      { name: "No Calendar Assignment", activeFrom: "2030-01-07" },
      week,
    );
    for (const personId of [noAssignmentPerson.id, randomUUID()]) {
      await expect(calendar.unassignHolidayCalendar(owner, personId)).rejects.toMatchObject({
        statusCode: 404,
        publicCode: "holiday_calendar_assignment_not_found",
      });
    }
    const crossOrganizationPerson = await planning.createPerson(
      context(ownerUserId, "owner", secondOrganizationId),
      { name: "Cross Organization Calendar Person", activeFrom: "2030-01-07" },
      week,
    );
    await expect(
      calendar.unassignHolidayCalendar(owner, crossOrganizationPerson.id),
    ).rejects.toMatchObject({
      statusCode: 404,
      publicCode: "holiday_calendar_assignment_not_found",
    });

    expect((await calendar.listLeave(member, "2030-01-01", "2030-01-31"))[0]).toHaveProperty(
      "leaveTypeId",
    );
    expect((await calendar.listLeave(viewer, "2030-01-01", "2030-01-31"))[0]).not.toHaveProperty(
      "leaveTypeId",
    );
    const otherPerson = await planning.createPerson(
      owner,
      { name: "Other Leave", activeFrom: "2030-01-07" },
      week,
    );
    await expect(
      calendar.createLeave(member, {
        personId: otherPerson.id,
        leaveTypeId: leaveType.id,
        startDate: "2030-01-10",
        endDate: "2030-01-10",
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const otherLeave = await calendar.createLeave(owner, {
      personId: otherPerson.id,
      leaveTypeId: leaveType.id,
      startDate: "2030-01-10",
      endDate: "2030-01-10",
    });
    await expect(
      calendar.updateLeave(member, otherLeave.id, {
        personId: person.id,
        leaveTypeId: leaveType.id,
        startDate: "2030-01-11",
        endDate: "2030-01-11",
        rowVersion: otherLeave.rowVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await expect(
      calendar.deleteLeave(member, otherLeave.id, otherLeave.rowVersion),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
    const untouched = await db().query<{ person_id: string; deleted_at: Date | null }>(
      `SELECT person_id, deleted_at FROM app.leave_entries WHERE organization_id = $1 AND id = $2`,
      [organizationId, otherLeave.id],
    );
    expect(untouched.rows[0]).toEqual({ person_id: otherPerson.id, deleted_at: null });
    await expect(
      calendar.updateLeave(member, leave.id, {
        personId: otherPerson.id,
        leaveTypeId: leaveType.id,
        startDate: "2030-01-09",
        endDate: "2030-01-09",
        rowVersion: leave.rowVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const memberOwn = await db().query<{ person_id: string }>(
      `SELECT person_id FROM app.leave_entries WHERE organization_id = $1 AND id = $2`,
      [organizationId, leave.id],
    );
    expect(memberOwn.rows[0]?.person_id).toBe(person.id);
    const reassigned = await calendar.updateLeave(context(ownerUserId, "planner"), otherLeave.id, {
      personId: person.id,
      leaveTypeId: leaveType.id,
      startDate: "2030-01-10",
      endDate: "2030-01-10",
      rowVersion: otherLeave.rowVersion,
    });
    expect(reassigned.personId).toBe(person.id);
    const crossOrgPerson = await planning.createPerson(
      context(ownerUserId, "owner", secondOrganizationId),
      { name: "Cross Organization Leave", activeFrom: "2030-01-07" },
      week,
    );
    await expect(
      calendar.updateLeave(context(ownerUserId, "planner"), otherLeave.id, {
        personId: crossOrgPerson.id,
        leaveTypeId: leaveType.id,
        startDate: "2030-01-10",
        endDate: "2030-01-10",
        rowVersion: reassigned.rowVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    await calendar.deleteLeave(member, leave.id, leave.rowVersion);
    await calendar.deleteLeave(member, otherLeave.id, reassigned.rowVersion);
  });

  it("derives and acknowledges conflicts with stable source-sensitive fingerprints", async () => {
    const person = await planning.createPerson(
      owner,
      { name: "Conflict Person", activeFrom: "2030-01-07" },
      week,
    );
    const project = await planning.createProject(owner, {
      name: "Conflict Project",
      kind: "billable",
      status: "confirmed",
    });
    await planning.createAllocation(owner, {
      personId: person.id,
      projectId: project.id,
      startDate: "2030-01-08",
      endDate: "2030-01-08",
      mode: "minutes_per_day",
      minutesPerDay: 600,
      state: "confirmed",
    });
    const conflicts = await derived.listConflicts(owner, {
      start: "2030-01-08",
      end: "2030-01-09",
      scenario: "confirmed_and_tentative",
    });
    const conflict = conflicts.find((candidate) => candidate.personId === person.id);
    if (!conflict) throw new Error("conflict unavailable");
    expect(conflict.source).toContain("exceeds effective capacity");
    await expect(derived.acknowledge(member, conflict.fingerprint)).rejects.toMatchObject({
      statusCode: 403,
    });
    await derived.acknowledge(context(ownerUserId, "planner"), conflict.fingerprint);
    expect(
      (
        await derived.listConflicts(viewer, {
          start: "2030-01-08",
          end: "2030-01-09",
          scenario: "confirmed_and_tentative",
        })
      ).find((candidate) => candidate.fingerprint === conflict.fingerprint)?.acknowledged,
    ).toBe(true);
    await derived.unacknowledge(owner, conflict.fingerprint);
  });

  it("searches earliest start with role/team/tags and returns explanation without assigning", async () => {
    const person = (await planning.listPeople(owner)).find((row) => row.name === "Catalog Person");
    if (!person) throw new Error("tagged person unavailable");
    const tags = await catalog.list(owner, "tags");
    const tag = tags.find((item) => item.name === "TypeScript");
    const role = (await catalog.list(owner, "delivery_roles")).find(
      (item) => item.name === "Engineer",
    );
    if (!tag || !role) throw new Error("search filters unavailable");
    const before = await planning.listAllocations(owner);
    const results = await derived.earliestStart(viewer, {
      notBefore: "2030-01-07",
      workdayCount: 2,
      dailyMinutes: 60,
      scenario: "confirmed",
      horizonDays: 30,
      roleId: role.id,
      tagIds: [tag.id],
    });
    expect(results[0]).toMatchObject({
      personId: person.id,
      minimumHeadroomMinutes: 420,
      continuousAllocationSafe: true,
    });
    expect(results[0]?.explanation).toContain("holidays");
    expect(await planning.listAllocations(owner)).toHaveLength(before.length);
  });

  it("marks holiday and full-leave completion ranges unsafe without assigning work", async () => {
    const holidayPerson = await planning.createPerson(
      owner,
      { name: "Holiday Finder Person", activeFrom: "2030-01-11" },
      week,
    );
    const holidayCalendar = await calendar.createHolidayCalendar(owner, "Finder Holidays");
    await calendar.addHolidayDate(owner, holidayCalendar.id, "2030-01-14", "Finder Holiday");
    await calendar.assignHolidayCalendar(owner, holidayPerson.id, holidayCalendar.id);
    const leavePerson = await planning.createPerson(
      owner,
      { name: "Leave Finder Person", activeFrom: "2030-01-11" },
      week,
    );
    const leaveType = await calendar.createLeaveType(owner, "Finder Leave");
    await calendar.createLeave(owner, {
      personId: leavePerson.id,
      leaveTypeId: leaveType.id,
      startDate: "2030-01-14",
      endDate: "2030-01-14",
    });
    const before = await planning.listAllocations(owner);

    const results = await derived.earliestStart(viewer, {
      notBefore: "2030-01-11",
      workdayCount: 2,
      dailyMinutes: 60,
      scenario: "confirmed",
      horizonDays: 14,
    });

    expect(results.find((result) => result.personId === holidayPerson.id)).toMatchObject({
      start: "2030-01-11",
      end: "2030-01-15",
      continuousAllocationSafe: false,
    });
    expect(results.find((result) => result.personId === leavePerson.id)).toMatchObject({
      start: "2030-01-11",
      end: "2030-01-15",
      continuousAllocationSafe: false,
    });
    expect(await planning.listAllocations(owner)).toHaveLength(before.length);
  });

  it("returns table-ready 13-week advisory forecast with timezone/week boundary and filters", async () => {
    await planning.updateSettings(owner, {
      timezone: "Asia/Dhaka",
      weekStartsOn: 7,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    const person = (await planning.listPeople(owner)).find((row) => row.name === "Leave Person");
    if (!person) throw new Error("forecast person unavailable");
    const forecast = await derived.forecast(viewer, { personId: person.id });
    expect(forecast.timezone).toBe("Asia/Dhaka");
    expect(forecast.weekStartsOn).toBe(7);
    expect(forecast.weeks).toHaveLength(13);
    expect(forecast.weeks[0]?.weekStart).toBe("2030-01-06");
    expect(forecast.assumptions).toContain("Advisory");
    expect(forecast.assumptions).toContain(
      "Target gap is based on confirmed billable minutes only",
    );
    expect(forecast.assumptions).toContain(
      "Potential utilization includes tentative and internal work",
    );
    expect(forecast.weeks[0]).toHaveProperty("tentativeBillableMinutes");
    expect(forecast.weeks[0]).not.toHaveProperty("revenue");
  });
});
