import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionContext } from "../src/auth-service.js";
import { PlanningService } from "../src/planning-service.js";

const enabled = process.env.AW_PLANNING_INTEGRATION === "1";
const connectionString = process.env.DATABASE_URL ?? "";
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;
const suffix = randomBytes(6).toString("hex");
let actorUserId = "";
let firstOrganization = "";
let secondOrganization = "";
let planning: PlanningService;

function db(): Pool {
  if (!pool) throw new Error("planning integration pool unavailable");
  return pool;
}

function superuserSql(sql: string): void {
  try {
    execFileSync(
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
  } catch {
    throw new Error("Planning integration cleanup failed without exposing database output");
  }
}

function actor(
  organizationId: string,
  role: SessionContext["role"] = "owner",
  userId = actorUserId,
): SessionContext {
  return {
    sessionId: randomUUID(),
    userId,
    organizationId,
    role,
    csrfHash: Buffer.alloc(32),
    absoluteExpiresAt: new Date("2031-01-01T00:00:00Z"),
  };
}

const week = Array.from({ length: 7 }, (_, index) => ({
  isoWeekday: index + 1,
  minutes: index < 5 ? 480 : 0,
}));

describe.skipIf(!enabled)("planning core PostgreSQL integration", () => {
  beforeAll(async () => {
    superuserSql(`
      SET session_replication_role = replica;
      DELETE FROM app.audit_events WHERE organization_id IN (SELECT id FROM app.organizations WHERE slug LIKE 'planning-it-%');
      DELETE FROM app.organizations WHERE slug LIKE 'planning-it-%';
      SET session_replication_role = origin;
    `);
    const owner = await db().query<{ user_id: string }>(
      `SELECT user_id FROM app.memberships WHERE role = 'owner' AND active ORDER BY created_at LIMIT 1`,
    );
    actorUserId = owner.rows[0]?.user_id ?? "";
    if (!actorUserId) throw new Error("integration actor unavailable");
    firstOrganization = randomUUID();
    secondOrganization = randomUUID();
    await db().query(
      `INSERT INTO app.organizations (id, slug, name)
       VALUES ($1, $3, 'Planning Integration A'), ($2, $4, 'Planning Integration B')`,
      [firstOrganization, secondOrganization, `planning-it-a-${suffix}`, `planning-it-b-${suffix}`],
    );
    planning = new PlanningService(db(), () => new Date("2030-01-07T12:00:00Z"));
  });

  afterAll(async () => {
    await pool?.end();
    superuserSql(`
      SET session_replication_role = replica;
      DELETE FROM app.audit_events WHERE organization_id IN ('${firstOrganization}', '${secondOrganization}');
      DELETE FROM app.organizations WHERE id IN ('${firstOrganization}', '${secondOrganization}');
      SET session_replication_role = origin;
    `);
  });

  it("creates settings, person, schedule, project, allocation, and calculated schedule", async () => {
    const owner = actor(firstOrganization);
    expect((await planning.getSettings(owner)).rowVersion).toBe(1);
    const settings = await planning.updateSettings(owner, {
      timezone: "Europe/London",
      weekStartsOn: 1,
      dateFormat: "DD MMM YYYY",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    expect(settings.rowVersion).toBe(2);
    const person = await planning.createPerson(
      owner,
      { name: "Integration Person", activeFrom: "2030-01-07" },
      week,
    );
    const project = await planning.createProject(owner, {
      name: "Integration Project",
      kind: "billable",
      status: "confirmed",
      targetStart: "2030-01-07",
      targetEnd: "2030-01-31",
    });
    const allocation = await planning.createAllocation(owner, {
      personId: person.id,
      projectId: project.id,
      startDate: "2030-01-07",
      endDate: "2030-01-11",
      mode: "minutes_per_day",
      minutesPerDay: 300,
      state: "confirmed",
    });
    expect(allocation.rowVersion).toBe(1);
    const schedule = await planning.getSchedule(owner, "2030-01-07", "2030-01-13", "confirmed");
    expect(schedule.people).toHaveLength(1);
    expect(schedule.people[0]?.days[0]).toMatchObject({
      date: "2030-01-07",
      capacityMinutes: 480,
      confirmedMinutes: 300,
      availableConfirmedMinutes: 180,
    });
    const audit = await db().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM app.audit_events WHERE organization_id = $1`,
      [firstOrganization],
    );
    expect(Number(audit.rows[0]?.count)).toBeGreaterThanOrEqual(4);
  });

  it("rejects overlapping schedules, stale writes, and cross-organization IDs", async () => {
    const owner = actor(firstOrganization);
    const person = (await planning.listPeople(owner))[0];
    if (!person) throw new Error("integration person unavailable");
    await expect(
      planning.addWorkSchedule(owner, person.id, "2030-01-07", "2030-02-01", week),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      planning.updatePerson(owner, person.id, {
        name: person.name,
        activeFrom: person.activeFrom,
        rowVersion: 999,
      }),
    ).rejects.toEqual(expect.objectContaining({ statusCode: 409, publicCode: "stale_write" }));

    const otherPerson = await planning.createPerson(
      actor(secondOrganization),
      { name: "Other Organization Person", activeFrom: "2030-01-07" },
      week,
    );
    await expect(planning.getPerson(owner, otherPerson.id)).rejects.toEqual(
      expect.objectContaining({ statusCode: 404, publicCode: "person_not_found" }),
    );

    for (const role of ["owner", "admin", "planner"] as const) {
      const managerView = await planning.listPeople(actor(firstOrganization, role));
      expect(managerView[0]?.email).toBeDefined();
    }
    for (const role of ["member", "viewer"] as const) {
      const restricted = await planning.listPeople(actor(firstOrganization, role));
      expect(restricted[0]).not.toHaveProperty("email");
      const detail = await planning.getPerson(actor(firstOrganization, role), person.id);
      expect(detail).not.toHaveProperty("email");
    }
  });

  it("allows concurrent allocations, derives conflict, and guards future archive/complete transitions", async () => {
    const owner = actor(firstOrganization);
    const person = (await planning.listPeople(owner))[0];
    const project = (await planning.listProjects(owner))[0];
    if (!person || !project) throw new Error("planning records unavailable");
    const input = {
      personId: person.id,
      projectId: project.id,
      startDate: "2030-01-07",
      endDate: "2030-01-07",
      mode: "minutes_per_day" as const,
      minutesPerDay: 300,
      state: "confirmed" as const,
    };
    const results = await Promise.all([
      planning.createAllocation(owner, input),
      planning.createAllocation(owner, input),
    ]);
    expect(results).toHaveLength(2);
    const schedule = await planning.getSchedule(owner, "2030-01-07", "2030-01-07", "confirmed");
    expect(schedule.conflicts[0]).toMatchObject({ severity: "confirmed" });
    await expect(planning.archivePerson(owner, person.id, person.rowVersion)).rejects.toMatchObject(
      {
        publicCode: "future_allocations_exist",
      },
    );
    await expect(
      planning.completeProject(owner, project.id, project.rowVersion),
    ).rejects.toMatchObject({
      publicCode: "future_allocations_exist",
    });
  });

  it("denies ordinary-role writes and rolls back mutations when transactional audit fails", async () => {
    const member = actor(firstOrganization, "member");
    await expect(
      planning.createProject(member, { name: "Denied", kind: "internal", status: "draft" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    const name = `Audit rollback ${suffix}`;
    await expect(
      planning.createProject(actor(firstOrganization, "owner", randomUUID()), {
        name,
        kind: "internal",
        status: "draft",
      }),
    ).rejects.toMatchObject({ code: "23503" });
    const stored = await db().query(
      `SELECT 1 FROM app.projects WHERE organization_id = $1 AND name = $2`,
      [firstOrganization, name],
    );
    expect(stored.rowCount).toBe(0);
  });

  it("excludes archived/deleted rows and rejects unusable allocation projects and invalid target dates", async () => {
    const owner = actor(firstOrganization);
    await expect(
      planning.createProject(owner, {
        name: "End without start",
        kind: "billable",
        status: "draft",
        targetEnd: "2030-02-01",
      }),
    ).rejects.toMatchObject({ publicCode: "invalid_project_dates" });

    const activePerson = (await planning.listPeople(owner))[0];
    const activeProject = (await planning.listProjects(owner))[0];
    if (!activePerson || !activeProject) throw new Error("active integration records unavailable");
    const disposableAllocation = await planning.createAllocation(owner, {
      personId: activePerson.id,
      projectId: activeProject.id,
      startDate: "2029-01-01",
      endDate: "2029-01-01",
      mode: "minutes_per_day",
      minutesPerDay: 60,
      state: "confirmed",
    });
    await planning.deleteAllocation(
      owner,
      disposableAllocation.id,
      disposableAllocation.rowVersion,
    );
    expect(
      (await planning.listAllocations(owner)).some((row) => row.id === disposableAllocation.id),
    ).toBe(false);

    const archivedPerson = await planning.createPerson(
      owner,
      { name: "Archived Person", activeFrom: "2020-01-01", activeUntil: "2020-12-31" },
      week,
    );
    await planning.archivePerson(owner, archivedPerson.id, archivedPerson.rowVersion);
    expect((await planning.listPeople(owner)).some((row) => row.id === archivedPerson.id)).toBe(
      false,
    );

    const archivedProject = await planning.createProject(owner, {
      name: "Archived Project",
      kind: "internal",
      status: "draft",
    });
    await planning.archiveProject(owner, archivedProject.id, archivedProject.rowVersion);
    expect((await planning.listProjects(owner)).some((row) => row.id === archivedProject.id)).toBe(
      false,
    );
    await expect(
      planning.createAllocation(owner, {
        personId: activePerson.id,
        projectId: archivedProject.id,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        state: "confirmed",
      }),
    ).rejects.toMatchObject({ publicCode: "project_not_allocatable" });

    const completedProject = await planning.createProject(owner, {
      name: "Completed Project",
      kind: "billable",
      status: "draft",
    });
    await db().query(
      `UPDATE app.projects SET status = 'completed', completed_at = now() WHERE organization_id = $1 AND id = $2`,
      [firstOrganization, completedProject.id],
    );
    await expect(
      planning.createAllocation(owner, {
        personId: activePerson.id,
        projectId: completedProject.id,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        state: "confirmed",
      }),
    ).rejects.toMatchObject({ publicCode: "project_not_allocatable" });

    const cancelledProject = await planning.createProject(owner, {
      name: "Cancelled Project",
      kind: "billable",
      status: "draft",
    });
    await db().query(
      `UPDATE app.projects SET status = 'cancelled' WHERE organization_id = $1 AND id = $2`,
      [firstOrganization, cancelledProject.id],
    );
    await expect(
      planning.updateAllocation(owner, disposableAllocation.id, {
        personId: activePerson.id,
        projectId: cancelledProject.id,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        state: "confirmed",
        rowVersion: disposableAllocation.rowVersion,
      }),
    ).rejects.toMatchObject({ publicCode: "project_not_allocatable" });
  });

  it("uses the organization timezone for future-allocation guards", async () => {
    const owner = actor(secondOrganization);
    const person = (await planning.listPeople(owner))[0];
    if (!person) throw new Error("timezone person unavailable");

    await planning.updateSettings(owner, {
      timezone: "America/Los_Angeles",
      weekStartsOn: 1,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    });
    const losAngelesProject = await planning.createProject(owner, {
      name: "Los Angeles Guard",
      kind: "billable",
      status: "confirmed",
    });
    await planning.createAllocation(owner, {
      personId: person.id,
      projectId: losAngelesProject.id,
      startDate: "2030-01-07",
      endDate: "2030-01-07",
      mode: "minutes_per_day",
      minutesPerDay: 60,
      state: "confirmed",
    });
    const losAngelesPlanning = new PlanningService(db(), () => new Date("2030-01-08T01:30:00Z"));
    await expect(
      losAngelesPlanning.completeProject(owner, losAngelesProject.id, losAngelesProject.rowVersion),
    ).rejects.toMatchObject({ publicCode: "future_allocations_exist" });

    const currentSettings = await planning.getSettings(owner);
    await planning.updateSettings(owner, {
      timezone: "Asia/Dhaka",
      weekStartsOn: 1,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: currentSettings.rowVersion,
    });
    const dhakaProject = await planning.createProject(owner, {
      name: "Dhaka Guard",
      kind: "billable",
      status: "confirmed",
    });
    await planning.createAllocation(owner, {
      personId: person.id,
      projectId: dhakaProject.id,
      startDate: "2030-01-07",
      endDate: "2030-01-07",
      mode: "minutes_per_day",
      minutesPerDay: 60,
      state: "confirmed",
    });
    const dhakaPlanning = new PlanningService(db(), () => new Date("2030-01-07T20:30:00Z"));
    await expect(
      dhakaPlanning.completeProject(owner, dhakaProject.id, dhakaProject.rowVersion),
    ).resolves.toBeUndefined();
  });
});
