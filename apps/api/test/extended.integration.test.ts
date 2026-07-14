import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionContext } from "../src/auth-service.js";
import { CalendarService } from "../src/calendar-service.js";
import { CatalogService } from "../src/catalog-service.js";
import { DerivedService } from "../src/derived-service.js";
import { PlanningService } from "../src/planning-service.js";

const enabled = process.env.AW_EXTENDED_INTEGRATION === "1";
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
  const result = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      "project-postgres",
      "psql",
      "--username",
      "myuser",
      "--dbname",
      "agency_workload",
      "--no-psqlrc",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
    { input: sql, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  void result;
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
    superuserSql(`
      SET session_replication_role = replica;
      DELETE FROM app.audit_events WHERE organization_id IN ('${organizationId}', '${secondOrganizationId}');
      DELETE FROM app.memberships WHERE organization_id IN ('${organizationId}', '${secondOrganizationId}');
      DELETE FROM app.organizations WHERE id IN ('${organizationId}', '${secondOrganizationId}');
      DELETE FROM app.users WHERE id IN ('${ownerUserId}', '${memberUserId}');
      SET session_replication_role = origin;
    `);
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
    const conflicts = await derived.listConflicts(owner, {
      start: "2030-01-08",
      end: "2030-01-09",
      scenario: "confirmed_and_tentative",
    });
    const conflict = conflicts[0];
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
      )[0]?.acknowledged,
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
    expect(results[0]).toMatchObject({ personId: person.id, minimumHeadroomMinutes: 420 });
    expect(results[0]?.explanation).toContain("holidays");
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
    expect(forecast.weeks[0]).toHaveProperty("tentativeBillableMinutes");
    expect(forecast.weeks[0]).not.toHaveProperty("revenue");
  });
});
