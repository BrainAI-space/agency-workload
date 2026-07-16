import type { Scenario, ScheduleResponse } from "./api";

export interface PlanningPeriod {
  today: string;
  start: string;
  end: string;
  weeks: string[];
}

export interface ScheduleSummary {
  scheduledPeople: number;
  conflictCount: number;
  availableMinutes: number;
}

function dateInTimezone(instant: Date, timezone: string): string {
  if (Number.isNaN(instant.getTime())) throw new Error("Reference instant is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) throw new Error("Organization date formatting failed");
  return `${year}-${month}-${day}`;
}

function utcDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Civil date format is invalid");
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("Civil date is invalid");
  }
  return date;
}

export function addCivilDays(value: string, days: number): string {
  if (!Number.isSafeInteger(days)) throw new Error("Civil day offset must be an integer");
  const date = utcDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isoWeekday(value: string): number {
  const weekday = utcDate(value).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function planningPeriod(
  referenceInstant: Date,
  timezone: string,
  weekStartsOn: number,
  weekOffset: number,
  weekCount: number,
): PlanningPeriod {
  if (!Number.isInteger(weekStartsOn) || weekStartsOn < 1 || weekStartsOn > 7) {
    throw new Error("ISO week start is invalid");
  }
  if (!Number.isInteger(weekOffset) || !Number.isInteger(weekCount) || weekCount < 1) {
    throw new Error("Planning period bounds are invalid");
  }
  const today = dateInTimezone(referenceInstant, timezone);
  const daysSinceStart = (isoWeekday(today) - weekStartsOn + 7) % 7;
  const start = addCivilDays(today, -daysSinceStart + weekOffset * 7);
  const weeks = Array.from({ length: weekCount }, (_, index) => addCivilDays(start, index * 7));
  return { today, start, end: addCivilDays(start, weekCount * 7 - 1), weeks };
}

export function startFinderNotBefore(period: PlanningPeriod): string {
  return period.start > period.today ? period.start : period.today;
}

export function summarizeScheduleWeek(
  schedule: ScheduleResponse | null,
  start: string,
  end: string,
  scenario: Scenario,
): ScheduleSummary {
  if (!schedule) return { scheduledPeople: 0, conflictCount: 0, availableMinutes: 0 };
  const peopleDays = schedule.people.map((entry) =>
    entry.days.filter((day) => day.date >= start && day.date <= end),
  );
  return {
    scheduledPeople: peopleDays.filter((days) =>
      days.some(
        (day) =>
          day.confirmedMinutes +
            (scenario === "confirmed_and_tentative" ? day.tentativeMinutes : 0) >
          0,
      ),
    ).length,
    conflictCount: schedule.conflicts.filter(
      (conflict) =>
        conflict.date >= start &&
        conflict.date <= end &&
        (scenario === "confirmed_and_tentative" || conflict.severity === "confirmed"),
    ).length,
    availableMinutes: peopleDays.reduce(
      (total, days) =>
        total +
        days.reduce(
          (sum, day) =>
            sum +
            (scenario === "confirmed"
              ? day.availableConfirmedMinutes
              : day.availableScenarioMinutes),
          0,
        ),
      0,
    ),
  };
}
