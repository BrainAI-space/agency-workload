import {
  type Allocation,
  type PersonPlan,
  parseLocalDate,
  type WorkScheduleVersion,
} from "@agency-workload/domain";
import type { Pool } from "pg";

export interface PlanFilters {
  personId?: string;
  teamId?: string;
  roleId?: string;
  projectId?: string;
  tagIds?: readonly string[];
}

export async function loadPersonPlans(
  pool: Pool,
  organizationId: string,
  start: string,
  end: string,
  filters: PlanFilters = {},
): Promise<PersonPlan[]> {
  const people = await pool.query<{
    id: string;
    active_from: string;
    active_until: string | null;
    delivery_role_id: string | null;
    team_id: string | null;
    tags: string[];
  }>(
    `SELECT person.id, person.active_from::text, person.active_until::text,
            person.delivery_role_id, person.team_id,
            COALESCE(array_agg(person_tag.tag_id::text) FILTER (WHERE person_tag.tag_id IS NOT NULL), '{}') AS tags
     FROM app.people person
     LEFT JOIN app.person_tags person_tag
       ON person_tag.organization_id = person.organization_id AND person_tag.person_id = person.id
     WHERE person.organization_id = $1 AND person.archived_at IS NULL
       AND person.active_from <= $3::date AND (person.active_until IS NULL OR person.active_until >= $2::date)
       AND ($4::uuid IS NULL OR person.id = $4)
       AND ($5::uuid IS NULL OR person.team_id = $5)
       AND ($6::uuid IS NULL OR person.delivery_role_id = $6)
     GROUP BY person.organization_id, person.id
     HAVING cardinality($7::uuid[]) = 0 OR $7::uuid[] <@ array_agg(person_tag.tag_id)
     ORDER BY person.id`,
    [
      organizationId,
      start,
      end,
      filters.personId ?? null,
      filters.teamId ?? null,
      filters.roleId ?? null,
      filters.tagIds ?? [],
    ],
  );
  const personIds = people.rows.map((person) => person.id);
  if (personIds.length === 0) return [];

  const [scheduleRows, holidayRows, leaveRows, allocationRows] = await Promise.all([
    pool.query<{
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
       WHERE version.organization_id = $1 AND version.person_id = ANY($2::uuid[])
         AND version.effective_from <= $4::date
         AND (version.effective_until IS NULL OR version.effective_until >= $3::date)
       ORDER BY version.person_id, version.effective_from, weekday.iso_weekday`,
      [organizationId, personIds, start, end],
    ),
    pool.query<{ person_id: string; holiday_date: string }>(
      `SELECT assignment.person_id, holiday.holiday_date::text
       FROM app.person_holiday_calendars assignment
       JOIN app.holiday_calendars calendar
         ON calendar.organization_id = assignment.organization_id
        AND calendar.id = assignment.calendar_id
       JOIN app.holiday_dates holiday
         ON holiday.organization_id = assignment.organization_id AND holiday.calendar_id = assignment.calendar_id
       WHERE assignment.organization_id = $1 AND assignment.person_id = ANY($2::uuid[])
         AND calendar.archived_at IS NULL
         AND holiday.holiday_date BETWEEN $3::date AND $4::date`,
      [organizationId, personIds, start, end],
    ),
    pool.query<{
      person_id: string;
      start_date: string;
      end_date: string;
      minutes_per_day: number | null;
    }>(
      `SELECT person_id, start_date::text, end_date::text, minutes_per_day
       FROM app.leave_entries
       WHERE organization_id = $1 AND person_id = ANY($2::uuid[]) AND deleted_at IS NULL
         AND end_date >= $3::date AND start_date <= $4::date`,
      [organizationId, personIds, start, end],
    ),
    pool.query<{
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
       WHERE allocation.organization_id = $1 AND allocation.person_id = ANY($2::uuid[])
         AND allocation.deleted_at IS NULL
         AND allocation.end_date >= $3::date AND allocation.start_date <= $4::date
         AND ($5::uuid IS NULL OR allocation.project_id = $5)`,
      [organizationId, personIds, start, end, filters.projectId ?? null],
    ),
  ]);

  return people.rows.map((person) => ({
    id: person.id,
    activeFrom: parseLocalDate(person.active_from),
    ...(person.active_until ? { activeUntil: parseLocalDate(person.active_until) } : {}),
    ...(person.delivery_role_id ? { roleId: person.delivery_role_id } : {}),
    ...(person.team_id ? { teamId: person.team_id } : {}),
    tags: person.tags,
    schedules: mapSchedules(scheduleRows.rows.filter((row) => row.person_id === person.id)),
    holidays: new Set(
      holidayRows.rows
        .filter((row) => row.person_id === person.id)
        .map((row) => parseLocalDate(row.holiday_date)),
    ),
    leave: leaveRows.rows
      .filter((row) => row.person_id === person.id)
      .map((row) => ({
        start: parseLocalDate(row.start_date),
        end: parseLocalDate(row.end_date),
        ...(row.minutes_per_day ? { minutesPerDay: row.minutes_per_day } : {}),
      })),
    allocations: allocationRows.rows
      .filter((row) => row.person_id === person.id)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        start: parseLocalDate(row.start_date),
        end: parseLocalDate(row.end_date),
        mode: row.mode,
        ...(row.minutes_per_day ? { minutesPerDay: row.minutes_per_day } : {}),
        ...(row.capacity_percent ? { capacityPercent: row.capacity_percent } : {}),
        state: row.allocation_state,
        kind: row.kind,
      })),
  }));
}

function mapSchedules(
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
