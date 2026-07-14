import { randomUUID } from "node:crypto";
import type { AppRole } from "@agency-workload/contracts";
import { parseLocalDate } from "@agency-workload/domain";
import type { Pool, PoolClient } from "pg";
import type { SessionContext } from "./auth-service.js";
import { HttpError } from "./errors.js";

const planningRoles: readonly AppRole[] = ["owner", "admin", "planner"];
const structureRoles: readonly AppRole[] = ["owner", "admin"];

export interface LeaveInput {
  personId: string;
  leaveTypeId: string;
  startDate: string;
  endDate: string;
  minutesPerDay?: number | null;
}

function validateDates(start: string, end: string): void {
  if (parseLocalDate(end) < parseLocalDate(start)) throw new HttpError(400, "invalid_date_range");
}

export class CalendarService {
  constructor(private readonly pool: Pool) {}

  async listHolidayCalendars(actor: SessionContext) {
    return (
      await this.pool.query(
        `SELECT calendar.id, calendar.name, calendar.row_version AS "rowVersion",
                COALESCE(json_agg(json_build_object('date', holiday.holiday_date::text, 'name', holiday.name)
                         ORDER BY holiday.holiday_date) FILTER (WHERE holiday.holiday_date IS NOT NULL), '[]') AS dates
         FROM app.holiday_calendars calendar
         LEFT JOIN app.holiday_dates holiday
           ON holiday.organization_id = calendar.organization_id AND holiday.calendar_id = calendar.id
         WHERE calendar.organization_id = $1 AND calendar.archived_at IS NULL
         GROUP BY calendar.organization_id, calendar.id, calendar.name, calendar.row_version
         ORDER BY lower(calendar.name), calendar.id`,
        [actor.organizationId],
      )
    ).rows;
  }

  async createHolidayCalendar(actor: SessionContext, name: string) {
    this.requireRole(actor, structureRoles);
    return this.createNamed(actor, "holiday_calendars", "holiday_calendar", name);
  }

  async updateHolidayCalendar(actor: SessionContext, id: string, name: string, rowVersion: number) {
    this.requireRole(actor, structureRoles);
    return this.updateNamed(actor, "holiday_calendars", "holiday_calendar", id, name, rowVersion);
  }

  async archiveHolidayCalendar(
    actor: SessionContext,
    id: string,
    rowVersion: number,
  ): Promise<void> {
    this.requireRole(actor, structureRoles);
    await this.archiveNamed(actor, "holiday_calendars", "holiday_calendar", id, rowVersion);
  }

  async addHolidayDate(actor: SessionContext, calendarId: string, date: string, name: string) {
    this.requireRole(actor, structureRoles);
    parseLocalDate(date);
    return this.withConflict(
      this.transaction(async (client) => {
        await this.requireActive(client, "holiday_calendars", actor.organizationId, calendarId);
        const result = await client.query(
          `INSERT INTO app.holiday_dates (organization_id, calendar_id, holiday_date, name)
         VALUES ($1, $2, $3, $4)
         RETURNING holiday_date::text AS date, name`,
          [actor.organizationId, calendarId, date, name.trim()],
        );
        await this.audit(client, actor, "holiday_date.created", "holiday_calendar", calendarId);
        return result.rows[0];
      }),
      "holiday_date_conflict",
    );
  }

  async removeHolidayDate(actor: SessionContext, calendarId: string, date: string): Promise<void> {
    this.requireRole(actor, structureRoles);
    parseLocalDate(date);
    await this.transaction(async (client) => {
      const result = await client.query(
        `DELETE FROM app.holiday_dates
         WHERE organization_id = $1 AND calendar_id = $2 AND holiday_date = $3 RETURNING calendar_id`,
        [actor.organizationId, calendarId, date],
      );
      if (!result.rowCount) throw new HttpError(404, "holiday_date_not_found");
      await this.audit(client, actor, "holiday_date.deleted", "holiday_calendar", calendarId);
    });
  }

  async assignHolidayCalendar(
    actor: SessionContext,
    personId: string,
    calendarId: string,
  ): Promise<void> {
    this.requireRole(actor, structureRoles);
    await this.transaction(async (client) => {
      await this.requireActive(client, "people", actor.organizationId, personId);
      await this.requireActive(client, "holiday_calendars", actor.organizationId, calendarId);
      await client.query(
        `INSERT INTO app.person_holiday_calendars (organization_id, person_id, calendar_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, person_id) DO UPDATE SET calendar_id = EXCLUDED.calendar_id`,
        [actor.organizationId, personId, calendarId],
      );
      await this.audit(client, actor, "holiday_calendar.assigned", "person", personId);
    });
  }

  async listLeaveTypes(actor: SessionContext) {
    return (
      await this.pool.query(
        `SELECT id, name, row_version AS "rowVersion"
         FROM app.leave_types WHERE organization_id = $1 AND archived_at IS NULL ORDER BY lower(name), id`,
        [actor.organizationId],
      )
    ).rows;
  }

  async createLeaveType(actor: SessionContext, name: string) {
    this.requireRole(actor, structureRoles);
    return this.createNamed(actor, "leave_types", "leave_type", name);
  }

  async updateLeaveType(actor: SessionContext, id: string, name: string, rowVersion: number) {
    this.requireRole(actor, structureRoles);
    return this.updateNamed(actor, "leave_types", "leave_type", id, name, rowVersion);
  }

  async archiveLeaveType(actor: SessionContext, id: string, rowVersion: number): Promise<void> {
    this.requireRole(actor, structureRoles);
    await this.archiveNamed(actor, "leave_types", "leave_type", id, rowVersion);
  }

  async listLeave(actor: SessionContext, start: string, end: string, personId?: string) {
    validateDates(start, end);
    const linkedPersonId = await this.linkedPerson(actor);
    const result = await this.pool.query<{
      id: string;
      personId: string;
      leaveTypeId: string;
      leaveTypeName: string;
      startDate: string;
      endDate: string;
      minutesPerDay: number | null;
      rowVersion: number;
    }>(
      `SELECT entry.id, entry.person_id AS "personId", entry.leave_type_id AS "leaveTypeId",
              type.name AS "leaveTypeName", entry.start_date::text AS "startDate",
              entry.end_date::text AS "endDate", entry.minutes_per_day AS "minutesPerDay",
              entry.row_version AS "rowVersion"
       FROM app.leave_entries entry
       JOIN app.leave_types type
         ON type.organization_id = entry.organization_id AND type.id = entry.leave_type_id
       WHERE entry.organization_id = $1 AND entry.deleted_at IS NULL
         AND entry.end_date >= $2::date AND entry.start_date <= $3::date
         AND ($4::uuid IS NULL OR entry.person_id = $4)
       ORDER BY entry.start_date, entry.id`,
      [actor.organizationId, start, end, personId ?? null],
    );
    return result.rows.map((row) => {
      if (
        planningRoles.includes(actor.role) ||
        (actor.role === "member" && linkedPersonId === row.personId)
      ) {
        return row;
      }
      return { id: row.id, personId: row.personId, startDate: row.startDate, endDate: row.endDate };
    });
  }

  async createLeave(actor: SessionContext, input: LeaveInput) {
    validateDates(input.startDate, input.endDate);
    await this.requireLeaveManagement(actor, input.personId);
    return this.transaction(async (client) => {
      await this.requireActive(client, "people", actor.organizationId, input.personId);
      await this.requireActive(client, "leave_types", actor.organizationId, input.leaveTypeId);
      const id = randomUUID();
      const result = await client.query(
        `INSERT INTO app.leave_entries
         (organization_id, id, person_id, leave_type_id, start_date, end_date, minutes_per_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, person_id AS "personId", leave_type_id AS "leaveTypeId",
                   start_date::text AS "startDate", end_date::text AS "endDate",
                   minutes_per_day AS "minutesPerDay", row_version AS "rowVersion"`,
        [
          actor.organizationId,
          id,
          input.personId,
          input.leaveTypeId,
          input.startDate,
          input.endDate,
          input.minutesPerDay ?? null,
        ],
      );
      await this.audit(client, actor, "leave.created", "leave", id);
      return result.rows[0];
    });
  }

  async updateLeave(actor: SessionContext, id: string, input: LeaveInput & { rowVersion: number }) {
    validateDates(input.startDate, input.endDate);
    return this.transaction(async (client) => {
      const existing = await client.query<{ person_id: string; row_version: number }>(
        `SELECT person_id, row_version FROM app.leave_entries
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [actor.organizationId, id],
      );
      const stored = existing.rows[0];
      if (!stored) throw new HttpError(404, "leave_not_found");
      await this.requireLeaveManagement(actor, stored.person_id, client);
      if (actor.role === "member" && input.personId !== stored.person_id) {
        throw new HttpError(404, "leave_not_found");
      }
      if (stored.row_version !== input.rowVersion) throw new HttpError(409, "stale_write");
      await this.requireActive(client, "people", actor.organizationId, input.personId);
      await this.requireActive(client, "leave_types", actor.organizationId, input.leaveTypeId);
      const result = await client.query(
        `UPDATE app.leave_entries
         SET person_id = $1, leave_type_id = $2, start_date = $3, end_date = $4,
             minutes_per_day = $5, row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $6 AND id = $7 AND row_version = $8 AND deleted_at IS NULL
         RETURNING id, person_id AS "personId", leave_type_id AS "leaveTypeId",
                   start_date::text AS "startDate", end_date::text AS "endDate",
                   minutes_per_day AS "minutesPerDay", row_version AS "rowVersion"`,
        [
          input.personId,
          input.leaveTypeId,
          input.startDate,
          input.endDate,
          input.minutesPerDay ?? null,
          actor.organizationId,
          id,
          input.rowVersion,
        ],
      );
      if (!result.rows[0])
        await this.missingOrStale(client, "leave_entries", actor.organizationId, id);
      await this.audit(client, actor, "leave.updated", "leave", id);
      return result.rows[0];
    });
  }

  async deleteLeave(actor: SessionContext, id: string, rowVersion: number): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<{ person_id: string; row_version: number }>(
        `SELECT person_id, row_version FROM app.leave_entries
         WHERE organization_id = $1 AND id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [actor.organizationId, id],
      );
      const stored = existing.rows[0];
      if (!stored) throw new HttpError(404, "leave_not_found");
      await this.requireLeaveManagement(actor, stored.person_id, client);
      if (stored.row_version !== rowVersion) throw new HttpError(409, "stale_write");
      const result = await client.query(
        `UPDATE app.leave_entries SET deleted_at = now(), row_version = row_version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND row_version = $3 AND deleted_at IS NULL RETURNING id`,
        [actor.organizationId, id, rowVersion],
      );
      if (!result.rowCount)
        await this.missingOrStale(client, "leave_entries", actor.organizationId, id);
      await this.audit(client, actor, "leave.deleted", "leave", id);
    });
  }

  private async linkedPerson(
    actor: SessionContext,
    connection: Pick<Pool, "query"> | Pick<PoolClient, "query"> = this.pool,
  ): Promise<string | null> {
    if (actor.role !== "member") return null;
    const result = await connection.query<{ linked_person_id: string | null }>(
      `SELECT linked_person_id FROM app.memberships
       WHERE organization_id = $1 AND user_id = $2 AND active`,
      [actor.organizationId, actor.userId],
    );
    return result.rows[0]?.linked_person_id ?? null;
  }

  private async requireLeaveManagement(
    actor: SessionContext,
    personId: string,
    connection: Pick<Pool, "query"> | Pick<PoolClient, "query"> = this.pool,
  ): Promise<void> {
    if (planningRoles.includes(actor.role)) return;
    if (actor.role === "member" && (await this.linkedPerson(actor, connection)) === personId)
      return;
    throw new HttpError(404, "leave_not_found");
  }

  private requireRole(actor: SessionContext, roles: readonly AppRole[]): void {
    if (!roles.includes(actor.role)) throw new HttpError(403, "forbidden");
  }

  private createNamed(
    actor: SessionContext,
    table: "holiday_calendars" | "leave_types",
    target: string,
    name: string,
  ) {
    return this.withConflict(
      this.transaction(async (client) => {
        const id = randomUUID();
        const result = await client.query(
          `INSERT INTO app.${table} (organization_id, id, name) VALUES ($1, $2, $3)
         RETURNING id, name, row_version AS "rowVersion"`,
          [actor.organizationId, id, name.trim()],
        );
        await this.audit(client, actor, `${target}.created`, target, id);
        return result.rows[0];
      }),
      target === "holiday_calendar" ? "holiday_calendar_name_conflict" : "leave_type_name_conflict",
    );
  }

  private updateNamed(
    actor: SessionContext,
    table: "holiday_calendars" | "leave_types",
    target: string,
    id: string,
    name: string,
    rowVersion: number,
  ) {
    return this.withConflict(
      this.transaction(async (client) => {
        const result = await client.query(
          `UPDATE app.${table} SET name = $1, row_version = row_version + 1
         WHERE organization_id = $2 AND id = $3 AND row_version = $4 AND archived_at IS NULL
         RETURNING id, name, row_version AS "rowVersion"`,
          [name.trim(), actor.organizationId, id, rowVersion],
        );
        if (!result.rows[0]) await this.missingOrStale(client, table, actor.organizationId, id);
        await this.audit(client, actor, `${target}.updated`, target, id);
        return result.rows[0];
      }),
      target === "holiday_calendar" ? "holiday_calendar_name_conflict" : "leave_type_name_conflict",
    );
  }

  private archiveNamed(
    actor: SessionContext,
    table: "holiday_calendars" | "leave_types",
    target: string,
    id: string,
    rowVersion: number,
  ) {
    return this.transaction(async (client) => {
      const result = await client.query(
        `UPDATE app.${table} SET archived_at = now(), row_version = row_version + 1
         WHERE organization_id = $1 AND id = $2 AND row_version = $3 AND archived_at IS NULL RETURNING id`,
        [actor.organizationId, id, rowVersion],
      );
      if (!result.rowCount) await this.missingOrStale(client, table, actor.organizationId, id);
      await this.audit(client, actor, `${target}.archived`, target, id);
    });
  }

  private async requireActive(
    client: PoolClient,
    table: "people" | "holiday_calendars" | "leave_types",
    organizationId: string,
    id: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM app.${table} WHERE organization_id = $1 AND id = $2 AND archived_at IS NULL`,
      [organizationId, id],
    );
    if (!result.rowCount) throw new HttpError(404, "not_found");
  }

  private async missingOrStale(
    client: PoolClient,
    table: "holiday_calendars" | "leave_types" | "leave_entries",
    organizationId: string,
    id: string,
  ): Promise<never> {
    const result = await client.query(
      `SELECT 1 FROM app.${table} WHERE organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    throw new HttpError(result.rowCount ? 409 : 404, result.rowCount ? "stale_write" : "not_found");
  }

  private async withConflict<T>(operation: Promise<T>, publicCode: string): Promise<T> {
    try {
      return await operation;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new HttpError(409, publicCode);
      }
      throw error;
    }
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
