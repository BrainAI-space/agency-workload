import { randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import {
  type Allocation,
  calculateRange,
  deriveConflicts,
  formatLocalDate,
  type PersonPlan,
  parseLocalDate,
  plannerDateForInstant,
  type Scenario,
  type WorkScheduleVersion,
} from "@agency-workload/domain";
import type { Pool, PoolClient } from "pg";
import type { SessionContext } from "./auth-service.js";
import { HttpError } from "./errors.js";
import {
  parsePlanningDate,
  validatePlanningRange,
  validatePlanningTimezone,
} from "./planning-validation.js";

const manageRoles: readonly AppRole[] = ["owner", "admin", "planner"];

export interface PersonInput {
  name: string;
  email?: string | null;
  teamId?: string | null;
  deliveryRoleId?: string | null;
  tagIds?: readonly string[];
  activeFrom: string;
  activeUntil?: string | null;
}

export interface WeekdayInput {
  isoWeekday: number;
  minutes: number;
}

export interface ProjectInput {
  name: string;
  kind: "billable" | "internal";
  status: "draft" | "tentative" | "confirmed";
  clientId?: string | null;
  targetStart?: string | null;
  targetEnd?: string | null;
}

export interface AllocationInput {
  personId: string;
  projectId: string;
  startDate: string;
  endDate: string;
  mode: "minutes_per_day" | "capacity_percent";
  minutesPerDay?: number;
  capacityPercent?: number;
  state: "confirmed" | "tentative";
}

interface PlanningSettingsResult {
  timezone: string;
  weekStartsOn: number;
  dateFormat: string;
  forecastHorizonWeeks: number;
  billableTargetPercent: number;
  rowVersion: number;
}

interface PersonResult {
  id: string;
  name: string;
  email: string | null;
  teamId: string | null;
  deliveryRoleId: string | null;
  tagIds: string[];
  activeFrom: string;
  activeUntil: string | null;
  rowVersion: number;
}

type ProjectedPerson = Omit<PersonResult, "email"> & { email?: string | null };

function validateRange(start: string, end?: string | null): void {
  validatePlanningRange(start, end);
}

function validateProjectDates(input: ProjectInput): void {
  if (input.targetEnd && !input.targetStart) throw new HttpError(400, "invalid_project_dates");
  if (input.targetStart) validateRange(input.targetStart, input.targetEnd);
}

function validateWeekdays(weekdays: readonly WeekdayInput[]): void {
  if (weekdays.length !== 7 || new Set(weekdays.map((day) => day.isoWeekday)).size !== 7) {
    throw new HttpError(400, "invalid_week_schedule");
  }
  for (const day of weekdays) {
    if (!Number.isInteger(day.isoWeekday) || day.isoWeekday < 1 || day.isoWeekday > 7) {
      throw new HttpError(400, "invalid_week_schedule");
    }
    if (!Number.isInteger(day.minutes) || day.minutes < 0 || day.minutes > 1440) {
      throw new HttpError(400, "invalid_week_schedule");
    }
  }
}

export class PlanningService {
  constructor(
    private readonly pool: Pool,
    private readonly instant: () => Date = () => new Date(),
  ) {}

  private requireManage(actor: SessionContext): void {
    if (!manageRoles.includes(actor.role)) throw new HttpError(403, "forbidden");
  }

  private canReadPersonEmail(actor: SessionContext): boolean {
    return manageRoles.includes(actor.role);
  }

  async getSettings(actor: SessionContext) {
    const result = await this.pool.query<PlanningSettingsResult>(
      `SELECT timezone, week_starts_on AS "weekStartsOn", date_format AS "dateFormat",
              forecast_horizon_weeks AS "forecastHorizonWeeks",
              billable_target_percent AS "billableTargetPercent", row_version AS "rowVersion"
       FROM app.organization_planning_settings WHERE organization_id = $1`,
      [actor.organizationId],
    );
    return (
      result.rows[0] ?? {
        timezone: "UTC",
        weekStartsOn: 1,
        dateFormat: "DD MMM YYYY",
        forecastHorizonWeeks: 13,
        billableTargetPercent: 75,
        rowVersion: 1,
      }
    );
  }

  async updateSettings(
    actor: SessionContext,
    input: {
      timezone: string;
      weekStartsOn: number;
      dateFormat: string;
      forecastHorizonWeeks: number;
      billableTargetPercent: number;
      rowVersion: number;
    },
  ) {
    this.requireManage(actor);
    validatePlanningTimezone(input.timezone);
    if (input.forecastHorizonWeeks < 13 || input.forecastHorizonWeeks > 52) {
      throw new HttpError(400, "invalid_forecast_horizon");
    }
    return this.transaction(async (client) => {
      await client.query(
        `SELECT pg_advisory_xact_lock(
           hashtext('organization_planning_settings'), hashtext($1::text)
         )`,
        [actor.organizationId],
      );
      const existing = await client.query<{ row_version: number }>(
        `SELECT row_version FROM app.organization_planning_settings
         WHERE organization_id = $1 FOR UPDATE`,
        [actor.organizationId],
      );
      let updated: PlanningSettingsResult | undefined;
      if (!existing.rows[0]) {
        if (input.rowVersion !== 1) throw new HttpError(409, "stale_write");
        const result = await client.query<PlanningSettingsResult>(
          `INSERT INTO app.organization_planning_settings
           (organization_id, timezone, week_starts_on, date_format, forecast_horizon_weeks,
            billable_target_percent, row_version)
           VALUES ($1, $2, $3, $4, $5, $6, 2)
           RETURNING timezone, week_starts_on AS "weekStartsOn", date_format AS "dateFormat",
                     forecast_horizon_weeks AS "forecastHorizonWeeks",
                     billable_target_percent AS "billableTargetPercent", row_version AS "rowVersion"`,
          [
            actor.organizationId,
            input.timezone,
            input.weekStartsOn,
            input.dateFormat,
            input.forecastHorizonWeeks,
            input.billableTargetPercent,
          ],
        );
        updated = result.rows[0];
      } else {
        if (existing.rows[0].row_version !== input.rowVersion)
          throw new HttpError(409, "stale_write");
        const result = await client.query<PlanningSettingsResult>(
          `UPDATE app.organization_planning_settings
           SET timezone = $1, week_starts_on = $2, date_format = $3,
               forecast_horizon_weeks = $4, billable_target_percent = $5,
               row_version = row_version + 1, updated_at = now()
           WHERE organization_id = $6
           RETURNING timezone, week_starts_on AS "weekStartsOn", date_format AS "dateFormat",
                     forecast_horizon_weeks AS "forecastHorizonWeeks",
                     billable_target_percent AS "billableTargetPercent", row_version AS "rowVersion"`,
          [
            input.timezone,
            input.weekStartsOn,
            input.dateFormat,
            input.forecastHorizonWeeks,
            input.billableTargetPercent,
            actor.organizationId,
          ],
        );
        updated = result.rows[0];
      }
      await this.audit(
        client,
        actor,
        "planning.settings_updated",
        "organization",
        actor.organizationId,
      );
      if (!updated) throw new Error("Planning settings update returned no row");
      return updated;
    });
  }

  async listPeople(actor: SessionContext) {
    const result = await this.pool.query<PersonResult>(
      `SELECT person.id, person.name, person.email, person.team_id AS "teamId",
              person.delivery_role_id AS "deliveryRoleId",
              active_from::text AS "activeFrom", active_until::text AS "activeUntil",
              row_version AS "rowVersion",
              COALESCE(array_agg(person_tag.tag_id::text) FILTER (WHERE person_tag.tag_id IS NOT NULL), '{}') AS "tagIds"
       FROM app.people person
       LEFT JOIN app.person_tags person_tag
         ON person_tag.organization_id = person.organization_id AND person_tag.person_id = person.id
       WHERE person.organization_id = $1 AND person.archived_at IS NULL
       GROUP BY person.organization_id, person.id ORDER BY person.name, person.id`,
      [actor.organizationId],
    );
    return result.rows.map((row) => this.projectPerson(row, actor));
  }

  async getPerson(actor: SessionContext, personId: string) {
    const person = await this.pool.query<PersonResult>(
      `SELECT person.id, person.name, person.email, person.team_id AS "teamId",
              person.delivery_role_id AS "deliveryRoleId",
              active_from::text AS "activeFrom", active_until::text AS "activeUntil",
              row_version AS "rowVersion",
              COALESCE(array_agg(person_tag.tag_id::text) FILTER (WHERE person_tag.tag_id IS NOT NULL), '{}') AS "tagIds"
       FROM app.people person
       LEFT JOIN app.person_tags person_tag
         ON person_tag.organization_id = person.organization_id AND person_tag.person_id = person.id
       WHERE person.organization_id = $1 AND person.id = $2 AND person.archived_at IS NULL
       GROUP BY person.organization_id, person.id`,
      [actor.organizationId, personId],
    );
    if (!person.rows[0]) throw new HttpError(404, "person_not_found");
    const schedules = await this.pool.query(
      `SELECT version.id, version.effective_from::text AS "effectiveFrom",
              version.effective_until::text AS "effectiveUntil",
              json_agg(json_build_object('isoWeekday', weekday.iso_weekday, 'minutes', weekday.minutes)
                       ORDER BY weekday.iso_weekday) AS weekdays
       FROM app.work_schedule_versions version
       JOIN app.work_schedule_weekdays weekday
         ON weekday.organization_id = version.organization_id AND weekday.schedule_version_id = version.id
       WHERE version.organization_id = $1 AND version.person_id = $2
       GROUP BY version.organization_id, version.id, version.effective_from, version.effective_until
       ORDER BY version.effective_from`,
      [actor.organizationId, personId],
    );
    return { ...this.projectPerson(person.rows[0], actor), schedules: schedules.rows };
  }

  async createPerson(actor: SessionContext, input: PersonInput, schedule: readonly WeekdayInput[]) {
    this.requireManage(actor);
    validateRange(input.activeFrom, input.activeUntil);
    validateWeekdays(schedule);
    return this.transaction(async (client) => {
      await this.requireAssignableCatalogs(
        client,
        actor.organizationId,
        input.teamId ?? null,
        input.deliveryRoleId ?? null,
      );
      const personId = randomUUID();
      await client.query(
        `INSERT INTO app.people
         (organization_id, id, name, email, team_id, delivery_role_id, active_from, active_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          actor.organizationId,
          personId,
          input.name,
          input.email ?? null,
          input.teamId ?? null,
          input.deliveryRoleId ?? null,
          input.activeFrom,
          input.activeUntil ?? null,
        ],
      );
      await this.insertSchedule(
        client,
        actor.organizationId,
        personId,
        input.activeFrom,
        null,
        schedule,
      );
      await this.replacePersonTags(client, actor.organizationId, personId, input.tagIds ?? []);
      await this.audit(client, actor, "person.created", "person", personId);
      return this.getPersonWithClient(client, actor.organizationId, personId);
    });
  }

  async updatePerson(
    actor: SessionContext,
    personId: string,
    input: PersonInput & { rowVersion: number },
  ) {
    this.requireManage(actor);
    validateRange(input.activeFrom, input.activeUntil);
    return this.transaction(async (client) => {
      await this.requireAssignableCatalogs(
        client,
        actor.organizationId,
        input.teamId ?? null,
        input.deliveryRoleId ?? null,
      );
      const result = await client.query(
        `UPDATE app.people
         SET name = $1, email = $2, team_id = $3, delivery_role_id = $4,
             active_from = $5, active_until = $6, row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $7 AND id = $8 AND row_version = $9 AND archived_at IS NULL
         RETURNING id, name, email, team_id AS "teamId", delivery_role_id AS "deliveryRoleId",
                   active_from::text AS "activeFrom", active_until::text AS "activeUntil",
                   row_version AS "rowVersion"`,
        [
          input.name,
          input.email ?? null,
          input.teamId ?? null,
          input.deliveryRoleId ?? null,
          input.activeFrom,
          input.activeUntil ?? null,
          actor.organizationId,
          personId,
          input.rowVersion,
        ],
      );
      if (!result.rows[0])
        await this.throwMissingOrStale(
          client,
          "people",
          actor.organizationId,
          personId,
          "person_not_found",
        );
      if (input.tagIds !== undefined) {
        await this.replacePersonTags(client, actor.organizationId, personId, input.tagIds);
      }
      await this.audit(client, actor, "person.updated", "person", personId);
      return this.getPersonWithClient(client, actor.organizationId, personId);
    });
  }

  async archivePerson(actor: SessionContext, personId: string, rowVersion: number): Promise<void> {
    this.requireManage(actor);
    await this.transaction(async (client) => {
      const target = await client.query<{ row_version: number }>(
        `SELECT row_version FROM app.people
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [actor.organizationId, personId],
      );
      const person = target.rows[0];
      if (!person) {
        return this.throwMissingOrStale(
          client,
          "people",
          actor.organizationId,
          personId,
          "person_not_found",
        );
      }
      if (person.row_version !== rowVersion) throw new HttpError(409, "stale_write");
      const future = await client.query(
        `SELECT 1 FROM app.allocations
         WHERE organization_id = $1 AND person_id = $2 AND deleted_at IS NULL AND end_date >= $3 LIMIT 1`,
        [
          actor.organizationId,
          personId,
          await this.organizationToday(client, actor.organizationId),
        ],
      );
      if (future.rowCount) throw new HttpError(409, "future_allocations_exist");
      await client.query(
        `UPDATE app.people SET archived_at = now(), row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [actor.organizationId, personId],
      );
      await this.audit(client, actor, "person.archived", "person", personId);
    });
  }

  async addWorkSchedule(
    actor: SessionContext,
    personId: string,
    effectiveFrom: string,
    effectiveUntil: string | undefined,
    weekdays: readonly WeekdayInput[],
  ) {
    this.requireManage(actor);
    validateRange(effectiveFrom, effectiveUntil);
    validateWeekdays(weekdays);
    return this.transaction(async (client) => {
      await this.requirePerson(client, actor.organizationId, personId);
      const id = await this.insertSchedule(
        client,
        actor.organizationId,
        personId,
        effectiveFrom,
        effectiveUntil ?? null,
        weekdays,
      );
      await this.audit(client, actor, "work_schedule.created", "work_schedule", id);
      return { id, effectiveFrom, effectiveUntil: effectiveUntil ?? null, weekdays };
    });
  }

  async listProjects(actor: SessionContext) {
    return (
      await this.pool.query(
        `SELECT id, client_id AS "clientId", name, kind, status,
                target_start::text AS "targetStart", target_end::text AS "targetEnd",
                row_version AS "rowVersion", completed_at AS "completedAt"
         FROM app.projects WHERE organization_id = $1 AND archived_at IS NULL ORDER BY name, id`,
        [actor.organizationId],
      )
    ).rows;
  }

  async getProject(actor: SessionContext, projectId: string) {
    const result = await this.pool.query(
      `SELECT id, client_id AS "clientId", name, kind, status,
              target_start::text AS "targetStart", target_end::text AS "targetEnd",
              row_version AS "rowVersion", completed_at AS "completedAt"
       FROM app.projects WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
      [actor.organizationId, projectId],
    );
    if (!result.rows[0]) throw new HttpError(404, "project_not_found");
    return result.rows[0];
  }

  async createProject(actor: SessionContext, input: ProjectInput) {
    this.requireManage(actor);
    validateProjectDates(input);
    return this.transaction(async (client) => {
      await this.requireProjectClient(client, actor.organizationId, input.clientId ?? null);
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO app.projects
         (organization_id, id, client_id, name, kind, status, target_start, target_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, client_id AS "clientId", name, kind, status,
                   target_start::text AS "targetStart", target_end::text AS "targetEnd",
                   row_version AS "rowVersion", completed_at AS "completedAt"`,
        [
          actor.organizationId,
          id,
          input.clientId ?? null,
          input.name,
          input.kind,
          input.status,
          input.targetStart ?? null,
          input.targetEnd ?? null,
        ],
      );
      await this.audit(client, actor, "project.created", "project", id);
      return result.rows[0];
    });
  }

  async updateProject(
    actor: SessionContext,
    projectId: string,
    input: ProjectInput & { rowVersion: number },
  ) {
    this.requireManage(actor);
    validateProjectDates(input);
    return this.transaction(async (client) => {
      const target = await client.query<{ row_version: number; status: string }>(
        `SELECT row_version, status FROM app.projects
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [actor.organizationId, projectId],
      );
      const project = target.rows[0];
      if (!project) {
        return this.throwMissingOrStale(
          client,
          "projects",
          actor.organizationId,
          projectId,
          "project_not_found",
        );
      }
      if (["completed", "cancelled"].includes(project.status)) {
        throw new HttpError(409, "invalid_project_transition");
      }
      if (project.row_version !== input.rowVersion) throw new HttpError(409, "stale_write");
      await this.requireProjectClient(client, actor.organizationId, input.clientId ?? null);
      const result = await client.query(
        `UPDATE app.projects
         SET client_id = $1, name = $2, kind = $3, status = $4,
             target_start = $5, target_end = $6, row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $7 AND id = $8 AND row_version = $9 AND archived_at IS NULL
         RETURNING id, client_id AS "clientId", name, kind, status,
                   target_start::text AS "targetStart", target_end::text AS "targetEnd",
                   row_version AS "rowVersion", completed_at AS "completedAt"`,
        [
          input.clientId ?? null,
          input.name,
          input.kind,
          input.status,
          input.targetStart ?? null,
          input.targetEnd ?? null,
          actor.organizationId,
          projectId,
          input.rowVersion,
        ],
      );
      if (!result.rows[0]) throw new HttpError(409, "stale_write");
      await this.audit(client, actor, "project.updated", "project", projectId);
      return result.rows[0];
    });
  }

  async archiveProject(
    actor: SessionContext,
    projectId: string,
    rowVersion: number,
  ): Promise<void> {
    this.requireManage(actor);
    await this.guardProjectTransition(actor, projectId, rowVersion, "archive");
  }

  async completeProject(
    actor: SessionContext,
    projectId: string,
    rowVersion: number,
  ): Promise<void> {
    this.requireManage(actor);
    await this.guardProjectTransition(actor, projectId, rowVersion, "complete");
  }

  async listAllocations(actor: SessionContext, start?: string, end?: string) {
    if (start) parsePlanningDate(start);
    if (end) parsePlanningDate(end);
    if (start && end) validateRange(start, end);
    return (
      await this.pool.query(
        `SELECT allocation.id, allocation.person_id AS "personId", allocation.project_id AS "projectId",
                allocation.start_date::text AS "startDate", allocation.end_date::text AS "endDate",
                allocation.mode, allocation.minutes_per_day AS "minutesPerDay",
                allocation.capacity_percent AS "capacityPercent", allocation.allocation_state AS state,
                allocation.row_version AS "rowVersion",
                project.kind
         FROM app.allocations allocation
         JOIN app.projects project
           ON project.organization_id = allocation.organization_id AND project.id = allocation.project_id
         WHERE allocation.organization_id = $1 AND allocation.deleted_at IS NULL
           AND ($2::date IS NULL OR allocation.end_date >= $2::date)
           AND ($3::date IS NULL OR allocation.start_date <= $3::date)
         ORDER BY allocation.start_date, allocation.id`,
        [actor.organizationId, start ?? null, end ?? null],
      )
    ).rows;
  }

  async createAllocation(actor: SessionContext, input: AllocationInput) {
    this.requireManage(actor);
    validateRange(input.startDate, input.endDate);
    this.validateAllocationMode(input);
    return this.transaction(async (client) => {
      // Allocation parent locks are always acquired person first, then project.
      await this.requirePerson(client, actor.organizationId, input.personId, true);
      await this.requireProject(client, actor.organizationId, input.projectId, true);
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO app.allocations
         (organization_id, id, person_id, project_id, start_date, end_date, mode,
          minutes_per_day, capacity_percent, allocation_state)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id, person_id AS "personId", project_id AS "projectId",
                   start_date::text AS "startDate", end_date::text AS "endDate", mode,
                   minutes_per_day AS "minutesPerDay", capacity_percent AS "capacityPercent",
                   allocation_state AS state, row_version AS "rowVersion"`,
        [
          actor.organizationId,
          id,
          input.personId,
          input.projectId,
          input.startDate,
          input.endDate,
          input.mode,
          input.mode === "minutes_per_day" ? input.minutesPerDay : null,
          input.mode === "capacity_percent" ? input.capacityPercent : null,
          input.state,
        ],
      );
      await this.audit(client, actor, "allocation.created", "allocation", id);
      return result.rows[0];
    });
  }

  async updateAllocation(
    actor: SessionContext,
    allocationId: string,
    input: AllocationInput & { rowVersion: number },
  ) {
    this.requireManage(actor);
    validateRange(input.startDate, input.endDate);
    this.validateAllocationMode(input);
    return this.transaction(async (client) => {
      // Allocation parent locks are always acquired person first, then project.
      await this.requirePerson(client, actor.organizationId, input.personId, true);
      await this.requireProject(client, actor.organizationId, input.projectId, true);
      const result = await client.query(
        `UPDATE app.allocations
         SET person_id = $1, project_id = $2, start_date = $3, end_date = $4,
             mode = $5, minutes_per_day = $6, capacity_percent = $7,
             allocation_state = $8, row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $9 AND id = $10 AND row_version = $11 AND deleted_at IS NULL
         RETURNING id, person_id AS "personId", project_id AS "projectId",
                   start_date::text AS "startDate", end_date::text AS "endDate", mode,
                   minutes_per_day AS "minutesPerDay", capacity_percent AS "capacityPercent",
                   allocation_state AS state, row_version AS "rowVersion"`,
        [
          input.personId,
          input.projectId,
          input.startDate,
          input.endDate,
          input.mode,
          input.mode === "minutes_per_day" ? input.minutesPerDay : null,
          input.mode === "capacity_percent" ? input.capacityPercent : null,
          input.state,
          actor.organizationId,
          allocationId,
          input.rowVersion,
        ],
      );
      if (!result.rows[0]) {
        await this.throwMissingOrStale(
          client,
          "allocations",
          actor.organizationId,
          allocationId,
          "allocation_not_found",
        );
      }
      await this.audit(client, actor, "allocation.updated", "allocation", allocationId);
      return result.rows[0];
    });
  }

  async deleteAllocation(
    actor: SessionContext,
    allocationId: string,
    rowVersion: number,
  ): Promise<void> {
    this.requireManage(actor);
    await this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE app.allocations
         SET deleted_at = now(), row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND row_version = $3 AND deleted_at IS NULL RETURNING id`,
        [actor.organizationId, allocationId, rowVersion],
      );
      if (!result.rowCount) {
        await this.throwMissingOrStale(
          client,
          "allocations",
          actor.organizationId,
          allocationId,
          "allocation_not_found",
        );
      }
      await this.audit(client, actor, "allocation.deleted", "allocation", allocationId);
    });
  }

  async getSchedule(actor: SessionContext, start: string, end: string, scenario: Scenario) {
    validateRange(start, end);
    const startOrdinal = parsePlanningDate(start);
    const endOrdinal = parsePlanningDate(end);
    if (endOrdinal - startOrdinal > 365) throw new HttpError(400, "date_range_too_large");
    const organizationId = actor.organizationId;
    const [people, scheduleRows, holidayRows, leaveRows, allocationRows] = await Promise.all([
      this.pool.query<{
        id: string;
        active_from: string;
        active_until: string | null;
        delivery_role_id: string | null;
        team_id: string | null;
      }>(
        `SELECT id, active_from::text, active_until::text, delivery_role_id, team_id
         FROM app.people
         WHERE organization_id = $1 AND archived_at IS NULL
           AND active_from <= $3::date AND (active_until IS NULL OR active_until >= $2::date)
         ORDER BY id`,
        [organizationId, start, end],
      ),
      this.pool.query<{
        person_id: string;
        id: string;
        effective_from: string;
        effective_until: string | null;
        iso_weekday: number;
        minutes: number;
      }>(
        `SELECT version.person_id, version.id, version.effective_from::text,
                version.effective_until::text, weekday.iso_weekday, weekday.minutes
         FROM app.work_schedule_versions version
         JOIN app.work_schedule_weekdays weekday
           ON weekday.organization_id = version.organization_id AND weekday.schedule_version_id = version.id
         WHERE version.organization_id = $1
           AND version.effective_from <= $3::date
           AND (version.effective_until IS NULL OR version.effective_until >= $2::date)
         ORDER BY version.person_id, version.effective_from, weekday.iso_weekday`,
        [organizationId, start, end],
      ),
      this.pool.query<{ person_id: string; holiday_date: string }>(
        `SELECT assignment.person_id, holiday.holiday_date::text
         FROM app.person_holiday_calendars assignment
         JOIN app.holiday_calendars calendar
           ON calendar.organization_id = assignment.organization_id
          AND calendar.id = assignment.calendar_id
         JOIN app.holiday_dates holiday
           ON holiday.organization_id = assignment.organization_id AND holiday.calendar_id = assignment.calendar_id
         WHERE assignment.organization_id = $1 AND calendar.archived_at IS NULL
           AND holiday.holiday_date BETWEEN $2::date AND $3::date`,
        [organizationId, start, end],
      ),
      this.pool.query<{
        person_id: string;
        start_date: string;
        end_date: string;
        minutes_per_day: number | null;
      }>(
        `SELECT person_id, start_date::text, end_date::text, minutes_per_day
         FROM app.leave_entries
         WHERE organization_id = $1 AND deleted_at IS NULL
           AND end_date >= $2::date AND start_date <= $3::date`,
        [organizationId, start, end],
      ),
      this.pool.query<{
        id: string;
        person_id: string;
        project_id: string;
        start_date: string;
        end_date: string;
        mode: Allocation["mode"];
        minutes_per_day: number | null;
        capacity_percent: number | null;
        allocation_state: Allocation["state"];
        kind: Allocation["kind"];
      }>(
        `SELECT allocation.id, allocation.person_id, allocation.project_id,
                allocation.start_date::text, allocation.end_date::text, allocation.mode,
                allocation.minutes_per_day, allocation.capacity_percent,
                allocation.allocation_state, project.kind
         FROM app.allocations allocation
         JOIN app.projects project
           ON project.organization_id = allocation.organization_id AND project.id = allocation.project_id
         WHERE allocation.organization_id = $1 AND allocation.deleted_at IS NULL
           AND allocation.end_date >= $2::date AND allocation.start_date <= $3::date`,
        [organizationId, start, end],
      ),
    ]);

    const plans = people.rows.map<PersonPlan>((row) => ({
      id: row.id,
      activeFrom: parseLocalDate(row.active_from),
      ...(row.active_until ? { activeUntil: parseLocalDate(row.active_until) } : {}),
      ...(row.delivery_role_id ? { roleId: row.delivery_role_id } : {}),
      ...(row.team_id ? { teamId: row.team_id } : {}),
      tags: [],
      schedules: this.mapSchedules(
        scheduleRows.rows.filter((schedule) => schedule.person_id === row.id),
      ),
      holidays: new Set(
        holidayRows.rows
          .filter((holiday) => holiday.person_id === row.id)
          .map((holiday) => parseLocalDate(holiday.holiday_date)),
      ),
      leave: leaveRows.rows
        .filter((leave) => leave.person_id === row.id)
        .map((leave) => ({
          start: parseLocalDate(leave.start_date),
          end: parseLocalDate(leave.end_date),
          ...(leave.minutes_per_day ? { minutesPerDay: leave.minutes_per_day } : {}),
        })),
      allocations: allocationRows.rows
        .filter((allocation) => allocation.person_id === row.id)
        .map((allocation) => ({
          id: allocation.id,
          projectId: allocation.project_id,
          start: parseLocalDate(allocation.start_date),
          end: parseLocalDate(allocation.end_date),
          mode: allocation.mode,
          ...(allocation.minutes_per_day ? { minutesPerDay: allocation.minutes_per_day } : {}),
          ...(allocation.capacity_percent ? { capacityPercent: allocation.capacity_percent } : {}),
          state: allocation.allocation_state,
          kind: allocation.kind,
        })),
    }));
    const days = plans.flatMap((plan) => calculateRange(plan, startOrdinal, endOrdinal, scenario));
    return {
      start,
      end,
      scenario,
      people: plans.map((plan) => ({
        personId: plan.id,
        days: days
          .filter((day) => day.personId === plan.id)
          .map((day) => ({ ...day, date: formatLocalDate(day.date) })),
      })),
      conflicts: deriveConflicts(days, scenario).map((conflict) => ({
        ...conflict,
        date: formatLocalDate(conflict.date),
      })),
    };
  }

  private validateAllocationMode(input: AllocationInput): void {
    if (
      (input.mode === "minutes_per_day" &&
        (!Number.isInteger(input.minutesPerDay) || input.capacityPercent !== undefined)) ||
      (input.mode === "capacity_percent" &&
        (!Number.isInteger(input.capacityPercent) || input.minutesPerDay !== undefined))
    ) {
      throw new HttpError(400, "invalid_allocation_mode");
    }
  }

  private mapSchedules(
    rows: readonly {
      id: string;
      effective_from: string;
      effective_until: string | null;
      iso_weekday: number;
      minutes: number;
    }[],
  ): WorkScheduleVersion[] {
    const groups = new Map<string, typeof rows>();
    for (const row of rows) groups.set(row.id, [...(groups.get(row.id) ?? []), row]);
    return [...groups.values()].map((scheduleRows) => {
      const first = scheduleRows[0];
      if (!first) throw new Error("Schedule row group is empty");
      const weekdayMinutes = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0 };
      for (const row of scheduleRows)
        weekdayMinutes[row.iso_weekday as keyof typeof weekdayMinutes] = row.minutes;
      return {
        effectiveFrom: parseLocalDate(first.effective_from),
        ...(first.effective_until ? { effectiveUntil: parseLocalDate(first.effective_until) } : {}),
        weekdayMinutes,
      };
    });
  }

  private async guardProjectTransition(
    actor: SessionContext,
    projectId: string,
    rowVersion: number,
    transition: "archive" | "complete",
  ): Promise<void> {
    await this.transaction(async (client) => {
      const target = await client.query<{ row_version: number; status: string }>(
        `SELECT row_version, status FROM app.projects
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL FOR UPDATE`,
        [actor.organizationId, projectId],
      );
      const project = target.rows[0];
      if (!project) {
        return this.throwMissingOrStale(
          client,
          "projects",
          actor.organizationId,
          projectId,
          "project_not_found",
        );
      }
      if (
        transition === "complete" &&
        !["draft", "tentative", "confirmed"].includes(project.status)
      ) {
        throw new HttpError(409, "invalid_project_transition");
      }
      if (project.row_version !== rowVersion) throw new HttpError(409, "stale_write");
      const future = await client.query(
        `SELECT 1 FROM app.allocations
         WHERE organization_id = $1 AND project_id = $2 AND deleted_at IS NULL AND end_date >= $3 LIMIT 1`,
        [
          actor.organizationId,
          projectId,
          await this.organizationToday(client, actor.organizationId),
        ],
      );
      if (future.rowCount) throw new HttpError(409, "future_allocations_exist");
      const setClause =
        transition === "archive"
          ? "archived_at = now(), row_version = row_version + 1, updated_at = now()"
          : "status = 'completed', completed_at = now(), row_version = row_version + 1, updated_at = now()";
      await client.query(
        `UPDATE app.projects SET ${setClause}
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [actor.organizationId, projectId],
      );
      await this.audit(client, actor, `project.${transition}d`, "project", projectId);
    });
  }

  private async insertSchedule(
    client: PoolClient,
    organizationId: string,
    personId: string,
    effectiveFrom: string,
    effectiveUntil: string | null,
    weekdays: readonly WeekdayInput[],
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO app.work_schedule_versions
       (organization_id, id, person_id, effective_from, effective_until) VALUES ($1, $2, $3, $4, $5)`,
      [organizationId, id, personId, effectiveFrom, effectiveUntil],
    );
    for (const weekday of weekdays) {
      await client.query(
        `INSERT INTO app.work_schedule_weekdays
         (organization_id, schedule_version_id, iso_weekday, minutes) VALUES ($1, $2, $3, $4)`,
        [organizationId, id, weekday.isoWeekday, weekday.minutes],
      );
    }
    return id;
  }

  private async getPersonWithClient(client: PoolClient, organizationId: string, personId: string) {
    const result = await client.query(
      `SELECT person.id, person.name, person.email, person.team_id AS "teamId",
              person.delivery_role_id AS "deliveryRoleId",
              active_from::text AS "activeFrom", active_until::text AS "activeUntil",
              row_version AS "rowVersion",
              COALESCE(array_agg(person_tag.tag_id::text) FILTER (WHERE person_tag.tag_id IS NOT NULL), '{}') AS "tagIds"
       FROM app.people person
       LEFT JOIN app.person_tags person_tag
         ON person_tag.organization_id = person.organization_id AND person_tag.person_id = person.id
       WHERE person.organization_id = $1 AND person.id = $2 AND person.archived_at IS NULL
       GROUP BY person.organization_id, person.id`,
      [organizationId, personId],
    );
    return result.rows[0];
  }

  private async requirePerson(
    client: PoolClient,
    organizationId: string,
    personId: string,
    lock = false,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM app.people
       WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL${lock ? " FOR UPDATE" : ""}`,
      [organizationId, personId],
    );
    if (!result.rowCount) throw new HttpError(404, "person_not_found");
  }

  private async requireProject(
    client: PoolClient,
    organizationId: string,
    projectId: string,
    lock = false,
  ): Promise<void> {
    const result = await client.query<{ status: string; archived_at: Date | null }>(
      `SELECT status, archived_at FROM app.projects
       WHERE organization_id = $1 AND id = $2${lock ? " FOR UPDATE" : ""}`,
      [organizationId, projectId],
    );
    const project = result.rows[0];
    if (!project) throw new HttpError(404, "project_not_found");
    if (project.archived_at || ["completed", "cancelled"].includes(project.status)) {
      throw new HttpError(409, "project_not_allocatable");
    }
  }

  private async requireProjectClient(
    client: PoolClient,
    organizationId: string,
    clientId: string | null,
  ): Promise<void> {
    if (!clientId) return;
    const result = await client.query<{ archived_at: Date | null }>(
      `SELECT archived_at FROM app.clients
       WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
      [organizationId, clientId],
    );
    const projectClient = result.rows[0];
    if (!projectClient) throw new HttpError(404, "client_not_found");
    if (projectClient.archived_at) throw new HttpError(409, "client_not_active");
  }

  private async requireAssignableCatalogs(
    client: PoolClient,
    organizationId: string,
    teamId: string | null,
    roleId: string | null,
  ): Promise<void> {
    if (teamId) {
      const team = await client.query(
        `SELECT 1 FROM app.teams WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [organizationId, teamId],
      );
      if (!team.rowCount) throw new HttpError(404, "team_not_found");
    }
    if (roleId) {
      const role = await client.query(
        `SELECT 1 FROM app.delivery_roles
         WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
        [organizationId, roleId],
      );
      if (!role.rowCount) throw new HttpError(404, "delivery_role_not_found");
    }
  }

  private async replacePersonTags(
    client: PoolClient,
    organizationId: string,
    personId: string,
    tagIds: readonly string[],
  ): Promise<void> {
    if (tagIds.length > 0) {
      const active = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM app.tags
         WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND archived_at IS NULL`,
        [organizationId, tagIds],
      );
      if (Number(active.rows[0]?.count) !== tagIds.length)
        throw new HttpError(404, "tag_not_found");
    }
    await client.query(
      `DELETE FROM app.person_tags WHERE organization_id = $1 AND person_id = $2`,
      [organizationId, personId],
    );
    for (const tagId of tagIds) {
      await client.query(
        `INSERT INTO app.person_tags (organization_id, person_id, tag_id) VALUES ($1, $2, $3)`,
        [organizationId, personId, tagId],
      );
    }
  }

  private projectPerson(row: PersonResult, actor: SessionContext): ProjectedPerson {
    if (this.canReadPersonEmail(actor)) return row;
    const { email: _email, ...safe } = row;
    return safe;
  }

  private async organizationToday(client: PoolClient, organizationId: string): Promise<string> {
    const result = await client.query<{ timezone: string }>(
      `SELECT COALESCE(
         (SELECT timezone FROM app.organization_planning_settings WHERE organization_id = $1),
         'UTC'
       ) AS timezone`,
      [organizationId],
    );
    return plannerDateForInstant(this.instant(), result.rows[0]?.timezone ?? "UTC");
  }

  private async throwMissingOrStale(
    client: PoolClient,
    table: "people" | "projects" | "allocations",
    organizationId: string,
    id: string,
    notFoundCode: string,
  ): Promise<never> {
    const existing = await client.query(
      `SELECT 1 FROM app.${table} WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    throw new HttpError(
      existing.rowCount ? 409 : 404,
      existing.rowCount ? "stale_write" : notFoundCode,
    );
  }

  private async audit(
    client: PoolClient,
    actor: SessionContext,
    action: string,
    targetType: string,
    targetId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO app.audit_events
       (id, organization_id, actor_user_id, action, target_type, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [randomUUID(), actor.organizationId, actor.userId, action, targetType, targetId],
    );
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
