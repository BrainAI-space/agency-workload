import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertExactPostgresIntegrationBoundary } from "../../../tools/lib/postgres-integration-boundary.mjs";
import type { SessionContext } from "../src/auth-service.js";
import { PlanningService } from "../src/planning-service.js";
import { type RaceStarter, runRowLockRace, sequentialRaceStarter } from "./row-lock-race.js";

const enabled = process.env.AW_PLANNING_INTEGRATION === "1";
if (enabled) assertExactPostgresIntegrationBoundary(process.env, "planning");
const connectionString = process.env.DATABASE_URL ?? "";
const pool = enabled ? new Pool({ connectionString, max: 8 }) : null;
const suffix = randomBytes(6).toString("hex");
let actorUserId = "";
let firstOrganization = "";
let secondOrganization = "";
let settingsOrganization = "";
let planning: PlanningService;

function db(): Pool {
  if (!pool) throw new Error("planning integration pool unavailable");
  return pool;
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

// The slowest PostgreSQL lifecycle race measures about 14s locally; 30s leaves CI headroom without masking hangs.
const lifecycleTestTimeout = 30_000;
const lifecycleLostCodes = ["future_allocations_exist"] as const;
const personAllocationLostCodes = ["person_not_found"] as const;
const projectAllocationLostCodes = ["project_not_allocatable"] as const;
const raceBusinessStatuses = {
  future_allocations_exist: 409,
  person_not_found: 404,
  project_not_allocatable: 409,
} as const;

type RaceBusinessCode = keyof typeof raceBusinessStatuses;
type AllocationLifecycleResults = [
  allocation: PromiseSettledResult<unknown>,
  lifecycle: PromiseSettledResult<unknown>,
];

async function settleAllocationLifecycle(
  table: "people" | "projects",
  rowId: string,
  allocation: () => Promise<unknown>,
  lifecycle: () => Promise<unknown>,
  starter?: RaceStarter,
): Promise<AllocationLifecycleResults> {
  return runRowLockRace({
    pool: db(),
    schema: "app",
    table,
    organizationId: firstOrganization,
    rowId,
    operations: [allocation, lifecycle],
    ...(starter ? { starter } : {}),
  });
}

function expectBusinessRejection(
  result: PromiseSettledResult<unknown>,
  allowedPublicCodes: readonly RaceBusinessCode[],
): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") throw new Error("expected a business rejection");

  const error = result.reason as {
    code?: unknown;
    publicCode?: unknown;
    statusCode?: unknown;
  };
  expect(error.code).not.toBe("40P01");
  expect(error).toEqual(
    expect.objectContaining({ publicCode: expect.any(String), statusCode: expect.any(Number) }),
  );
  const publicCode = error.publicCode as RaceBusinessCode;
  expect(allowedPublicCodes).toContain(publicCode);
  expect(error.statusCode).toBe(raceBusinessStatuses[publicCode]);
}

function expectSerializedAllocationLifecycle(
  results: AllocationLifecycleResults,
  allocationLostCodes: readonly RaceBusinessCode[],
): void {
  expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
  const [allocation, lifecycle] = results;
  if (allocation.status === "fulfilled") {
    expectBusinessRejection(lifecycle, lifecycleLostCodes);
    return;
  }

  expect(lifecycle.status).toBe("fulfilled");
  expectBusinessRejection(allocation, allocationLostCodes);
}

async function expectNoActiveAllocationForArchivedPerson(personId: string): Promise<void> {
  const state = await db().query<{ violations: string }>(
    `SELECT count(*)::text AS violations
     FROM app.allocations allocation
     JOIN app.people person
       ON person.organization_id = allocation.organization_id AND person.id = allocation.person_id
     WHERE allocation.organization_id = $1 AND allocation.person_id = $2
       AND allocation.deleted_at IS NULL AND person.archived_at IS NOT NULL`,
    [firstOrganization, personId],
  );
  expect(state.rows[0]?.violations).toBe("0");
}

async function expectNoActiveAllocationForTerminalProject(projectId: string): Promise<void> {
  const state = await db().query<{ violations: string }>(
    `SELECT count(*)::text AS violations
     FROM app.allocations allocation
     JOIN app.projects project
       ON project.organization_id = allocation.organization_id AND project.id = allocation.project_id
     WHERE allocation.organization_id = $1 AND allocation.project_id = $2
       AND allocation.deleted_at IS NULL
       AND (project.archived_at IS NOT NULL OR project.status IN ('completed', 'cancelled'))`,
    [firstOrganization, projectId],
  );
  expect(state.rows[0]?.violations).toBe("0");
}

describe.skipIf(!enabled)("planning core PostgreSQL integration", () => {
  beforeAll(async () => {
    const owner = await db().query<{ user_id: string }>(
      `SELECT user_id FROM app.memberships WHERE role = 'owner' AND active ORDER BY created_at LIMIT 1`,
    );
    actorUserId = owner.rows[0]?.user_id ?? "";
    if (!actorUserId) throw new Error("integration actor unavailable");
    firstOrganization = randomUUID();
    secondOrganization = randomUUID();
    settingsOrganization = randomUUID();
    await db().query(
      `INSERT INTO app.organizations (id, slug, name)
       VALUES ($1, $4, 'Planning Integration A'),
              ($2, $5, 'Planning Integration B'),
              ($3, $6, 'Planning Settings Concurrency')`,
      [
        firstOrganization,
        secondOrganization,
        settingsOrganization,
        `planning-it-a-${suffix}`,
        `planning-it-b-${suffix}`,
        `planning-it-settings-${suffix}`,
      ],
    );
    planning = new PlanningService(db(), () => new Date("2030-01-07T12:00:00Z"));
  });

  afterAll(async () => {
    await pool?.end();
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
    const updated = await planning.updatePerson(owner, person.id, {
      name: "Updated Integration Person",
      activeFrom: person.activeFrom,
      tagIds: [],
      rowVersion: person.rowVersion,
    });
    expect(updated).toMatchObject({
      name: "Updated Integration Person",
      tagIds: [],
      rowVersion: person.rowVersion + 1,
    });
    await expect(
      planning.updatePerson(owner, person.id, {
        name: person.name,
        activeFrom: person.activeFrom,
        rowVersion: person.rowVersion,
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

  it("serializes concurrent first planning-settings updates as one success and one stale write", async () => {
    const owner = actor(settingsOrganization);
    const input = {
      timezone: "UTC",
      weekStartsOn: 1,
      dateFormat: "YYYY-MM-DD",
      forecastHorizonWeeks: 13,
      billableTargetPercent: 75,
      rowVersion: 1,
    } as const;

    const results = await Promise.allSettled([
      planning.updateSettings(owner, input),
      planning.updateSettings(owner, { ...input, timezone: "Asia/Dhaka" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (!rejected) throw new Error("concurrent settings rejection unavailable");
    expect(rejected.reason).toEqual(
      expect.objectContaining({ statusCode: 409, publicCode: "stale_write" }),
    );
    expect((rejected.reason as { code?: string }).code).not.toBe("23505");
    const stored = await db().query<{ count: string; row_version: number }>(
      `SELECT count(*)::text AS count, max(row_version)::integer AS row_version
       FROM app.organization_planning_settings WHERE organization_id = $1`,
      [settingsOrganization],
    );
    expect(stored.rows[0]).toEqual({ count: "1", row_version: 2 });
  });

  it(
    "keeps completed and cancelled projects terminal while allowing guarded archival",
    async () => {
      const owner = actor(firstOrganization);
      for (const status of ["draft", "tentative", "confirmed"] as const) {
        const project = await planning.createProject(owner, {
          name: `Completable ${status} ${randomUUID()}`,
          kind: "billable",
          status,
        });
        await expect(
          planning.completeProject(owner, project.id, project.rowVersion),
        ).resolves.toBeUndefined();
        const completed = await planning.getProject(owner, project.id);
        expect(completed.status).toBe("completed");
        await expect(
          planning.completeProject(owner, project.id, completed.rowVersion),
        ).rejects.toMatchObject({ statusCode: 409, publicCode: "invalid_project_transition" });
        await expect(
          planning.updateProject(owner, project.id, {
            name: completed.name,
            kind: completed.kind,
            status: "draft",
            rowVersion: completed.rowVersion,
          }),
        ).rejects.toMatchObject({ statusCode: 409, publicCode: "invalid_project_transition" });
        await expect(
          planning.archiveProject(owner, project.id, completed.rowVersion),
        ).resolves.toBeUndefined();
      }

      const cancelled = await planning.createProject(owner, {
        name: `Cancelled terminal ${randomUUID()}`,
        kind: "internal",
        status: "draft",
      });
      await db().query(
        `UPDATE app.projects SET status = 'cancelled', row_version = row_version + 1
       WHERE organization_id = $1 AND id = $2`,
        [firstOrganization, cancelled.id],
      );
      const terminal = await planning.getProject(owner, cancelled.id);
      await expect(
        planning.completeProject(owner, cancelled.id, terminal.rowVersion),
      ).rejects.toMatchObject({ statusCode: 409, publicCode: "invalid_project_transition" });
      await expect(
        planning.updateProject(owner, cancelled.id, {
          name: terminal.name,
          kind: terminal.kind,
          status: "confirmed",
          rowVersion: terminal.rowVersion,
        }),
      ).rejects.toMatchObject({ statusCode: 409, publicCode: "invalid_project_transition" });
      await expect(
        planning.archiveProject(owner, cancelled.id, terminal.rowVersion),
      ).resolves.toBeUndefined();
    },
    lifecycleTestTimeout,
  );

  it(
    "keeps terminal project archival blocked while current or future allocations exist",
    async () => {
      const owner = actor(firstOrganization);
      const person = await planning.createPerson(
        owner,
        { name: `Terminal archive person ${randomUUID()}`, activeFrom: "2030-01-07" },
        week,
      );
      const project = await planning.createProject(owner, {
        name: `Terminal archive project ${randomUUID()}`,
        kind: "billable",
        status: "confirmed",
      });
      await planning.createAllocation(owner, {
        personId: person.id,
        projectId: project.id,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day",
        minutesPerDay: 60,
        state: "confirmed",
      });
      await db().query(
        `UPDATE app.projects
       SET status = 'cancelled', row_version = row_version + 1
       WHERE organization_id = $1 AND id = $2`,
        [firstOrganization, project.id],
      );
      const cancelled = await planning.getProject(owner, project.id);
      await expect(
        planning.archiveProject(owner, project.id, cancelled.rowVersion),
      ).rejects.toMatchObject({ statusCode: 409, publicCode: "future_allocations_exist" });
    },
    lifecycleTestTimeout,
  );

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

  it(
    "proves allocation and parent lifecycle writes overlap while preserving invariants",
    async () => {
      const owner = actor(firstOrganization);
      const createPerson = (name: string) =>
        planning.createPerson(owner, { name, activeFrom: "2030-01-07" }, week);
      const createProject = (name: string) =>
        planning.createProject(owner, { name, kind: "billable", status: "confirmed" });
      const allocationInput = (personId: string, projectId: string) => ({
        personId,
        projectId,
        startDate: "2030-01-07",
        endDate: "2030-01-07",
        mode: "minutes_per_day" as const,
        minutesPerDay: 60,
        state: "confirmed" as const,
      });

      const archivedPerson = await createPerson("Allocation Race Person Create");
      const personProject = await createProject("Allocation Race Person Project");
      const personCreateResults = await settleAllocationLifecycle(
        "people",
        archivedPerson.id,
        () =>
          planning.createAllocation(owner, allocationInput(archivedPerson.id, personProject.id)),
        () => planning.archivePerson(owner, archivedPerson.id, archivedPerson.rowVersion),
      );
      await expectNoActiveAllocationForArchivedPerson(archivedPerson.id);
      expectSerializedAllocationLifecycle(personCreateResults, personAllocationLostCodes);

      const completePerson = await createPerson("Allocation Race Complete Person");
      const completedProject = await createProject("Allocation Race Complete Project");
      const completeResults = await settleAllocationLifecycle(
        "projects",
        completedProject.id,
        () =>
          planning.createAllocation(owner, allocationInput(completePerson.id, completedProject.id)),
        () => planning.completeProject(owner, completedProject.id, completedProject.rowVersion),
      );
      await expectNoActiveAllocationForTerminalProject(completedProject.id);
      expectSerializedAllocationLifecycle(completeResults, projectAllocationLostCodes);

      const archivePerson = await createPerson("Allocation Race Project Archive Person");
      const archivedProject = await createProject("Allocation Race Project Archive");
      const archiveResults = await settleAllocationLifecycle(
        "projects",
        archivedProject.id,
        () =>
          planning.createAllocation(owner, allocationInput(archivePerson.id, archivedProject.id)),
        () => planning.archiveProject(owner, archivedProject.id, archivedProject.rowVersion),
      );
      await expectNoActiveAllocationForTerminalProject(archivedProject.id);
      expectSerializedAllocationLifecycle(archiveResults, projectAllocationLostCodes);

      const sourcePerson = await createPerson("Allocation Race Update Source Person");
      const targetPerson = await createPerson("Allocation Race Update Target Person");
      const updatePersonProject = await createProject("Allocation Race Update Person Project");
      const personAllocation = await planning.createAllocation(owner, {
        ...allocationInput(sourcePerson.id, updatePersonProject.id),
        startDate: "2029-01-01",
        endDate: "2029-01-01",
      });
      const updatePersonResults = await settleAllocationLifecycle(
        "people",
        targetPerson.id,
        () =>
          planning.updateAllocation(owner, personAllocation.id, {
            ...allocationInput(targetPerson.id, updatePersonProject.id),
            rowVersion: personAllocation.rowVersion,
          }),
        () => planning.archivePerson(owner, targetPerson.id, targetPerson.rowVersion),
      );
      await expectNoActiveAllocationForArchivedPerson(targetPerson.id);
      expectSerializedAllocationLifecycle(updatePersonResults, personAllocationLostCodes);

      const updateProjectPerson = await createPerson("Allocation Race Update Project Person");
      const sourceProject = await createProject("Allocation Race Update Source Project");
      const targetProject = await createProject("Allocation Race Update Target Project");
      const projectAllocation = await planning.createAllocation(owner, {
        ...allocationInput(updateProjectPerson.id, sourceProject.id),
        startDate: "2029-01-01",
        endDate: "2029-01-01",
      });
      const updateProjectResults = await settleAllocationLifecycle(
        "projects",
        targetProject.id,
        () =>
          planning.updateAllocation(owner, projectAllocation.id, {
            ...allocationInput(updateProjectPerson.id, targetProject.id),
            rowVersion: projectAllocation.rowVersion,
          }),
        () => planning.completeProject(owner, targetProject.id, targetProject.rowVersion),
      );
      await expectNoActiveAllocationForTerminalProject(targetProject.id);
      expectSerializedAllocationLifecycle(updateProjectResults, projectAllocationLostCodes);
    },
    lifecycleTestTimeout,
  );

  it(
    "rejects deliberately sequential lifecycle execution as overlap proof",
    async () => {
      const owner = actor(firstOrganization);
      const person = await planning.createPerson(
        owner,
        { name: "Sequential Control Person", activeFrom: "2030-01-07" },
        week,
      );
      const project = await planning.createProject(owner, {
        name: "Sequential Control Project",
        kind: "billable",
        status: "confirmed",
      });

      await expect(
        settleAllocationLifecycle(
          "people",
          person.id,
          () =>
            planning.createAllocation(owner, {
              personId: person.id,
              projectId: project.id,
              startDate: "2030-01-07",
              endDate: "2030-01-07",
              mode: "minutes_per_day",
              minutesPerDay: 60,
              state: "confirmed",
            }),
          () => planning.archivePerson(owner, person.id, person.rowVersion),
          sequentialRaceStarter,
        ),
      ).rejects.toThrow(/did not overlap while the target row lock was held/i);
      await expectNoActiveAllocationForArchivedPerson(person.id);
    },
    lifecycleTestTimeout,
  );

  it("excludes tentative-only conflicts from the confirmed API scenario", async () => {
    const owner = actor(firstOrganization);
    const person = await planning.createPerson(
      owner,
      { name: "Tentative Scenario Person", activeFrom: "2030-01-07" },
      week,
    );
    const project = await planning.createProject(owner, {
      name: "Tentative Scenario Project",
      kind: "billable",
      status: "tentative",
    });
    await planning.createAllocation(owner, {
      personId: person.id,
      projectId: project.id,
      startDate: "2030-01-07",
      endDate: "2030-01-07",
      mode: "minutes_per_day",
      minutesPerDay: 600,
      state: "tentative",
    });

    const confirmed = await planning.getSchedule(owner, "2030-01-07", "2030-01-07", "confirmed");
    expect(confirmed.conflicts.some((conflict) => conflict.personId === person.id)).toBe(false);

    const potential = await planning.getSchedule(
      owner,
      "2030-01-07",
      "2030-01-07",
      "confirmed_and_tentative",
    );
    expect(potential.conflicts.find((conflict) => conflict.personId === person.id)).toMatchObject({
      severity: "potential",
      overbookMinutes: 120,
    });
  });

  it("validates project clients before create and update writes", async () => {
    const owner = actor(firstOrganization);
    const activeClientId = randomUUID();
    const archivedClientId = randomUUID();
    const crossOrganizationClientId = randomUUID();
    await db().query(
      `INSERT INTO app.clients (organization_id, id, name, archived_at)
       VALUES ($1, $2, 'Active Client', NULL),
              ($1, $3, 'Archived Client', now()),
              ($4, $5, 'Cross Organization Client', NULL)`,
      [
        firstOrganization,
        activeClientId,
        archivedClientId,
        secondOrganization,
        crossOrganizationClientId,
      ],
    );

    const project = await planning.createProject(owner, {
      name: "Validated Client Project",
      kind: "billable",
      status: "draft",
      clientId: activeClientId,
    });
    expect(project.clientId).toBe(activeClientId);

    for (const clientId of [randomUUID(), crossOrganizationClientId]) {
      await expect(
        planning.createProject(owner, {
          name: `Missing Client ${clientId}`,
          kind: "billable",
          status: "draft",
          clientId,
        }),
      ).rejects.toMatchObject({ statusCode: 404, publicCode: "client_not_found" });
    }
    await expect(
      planning.createProject(owner, {
        name: "Archived Client Project",
        kind: "billable",
        status: "draft",
        clientId: archivedClientId,
      }),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "client_not_active" });
    await expect(
      planning.updateProject(owner, project.id, {
        name: project.name,
        kind: project.kind,
        status: "draft",
        clientId: crossOrganizationClientId,
        rowVersion: project.rowVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 404, publicCode: "client_not_found" });
    await expect(
      planning.updateProject(owner, project.id, {
        name: project.name,
        kind: project.kind,
        status: "draft",
        clientId: archivedClientId,
        rowVersion: project.rowVersion,
      }),
    ).rejects.toMatchObject({ statusCode: 409, publicCode: "client_not_active" });
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
    const activeProject = (await planning.listProjects(owner)).find(
      (project) => !["completed", "cancelled"].includes(project.status),
    );
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
