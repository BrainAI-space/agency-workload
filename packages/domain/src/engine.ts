import { addDays, type DateOrdinal, eachDate, isoWeekday } from "./dates.js";
import type {
  Allocation,
  CapacityAggregate,
  CapacityConflict,
  DailyCapacity,
  EarliestStartRequest,
  EarliestStartResult,
  ForecastWeek,
  PersonPlan,
  Scenario,
  WorkScheduleVersion,
} from "./types.js";

function assertMinutes(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label} must be non-negative integer minutes`);
}

export function roundHalfUp(numerator: number, denominator: number): number {
  if (
    !Number.isSafeInteger(numerator) ||
    numerator < 0 ||
    !Number.isSafeInteger(denominator) ||
    denominator <= 0
  ) {
    throw new Error("Rounding operands must be safe positive integers");
  }
  return Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
}

export function allocationMinutes(
  allocation: Allocation,
  baselineScheduledMinutes: number,
): number {
  assertMinutes(baselineScheduledMinutes, "Baseline scheduled capacity");
  if (baselineScheduledMinutes === 0) return 0;
  if (allocation.mode === "minutes_per_day") {
    assertMinutes(allocation.minutesPerDay ?? -1, "Allocation");
    return allocation.minutesPerDay ?? 0;
  }
  const percent = allocation.capacityPercent;
  if (!Number.isSafeInteger(percent) || percent === undefined || percent < 0 || percent > 1000) {
    throw new Error("Capacity percent must be an integer from 0 to 1000");
  }
  return roundHalfUp(baselineScheduledMinutes * percent, 100);
}

function scheduleFor(
  schedules: readonly WorkScheduleVersion[],
  date: DateOrdinal,
): WorkScheduleVersion | null {
  const matches = schedules.filter(
    (schedule) =>
      schedule.effectiveFrom <= date &&
      (schedule.effectiveUntil === undefined || schedule.effectiveUntil >= date),
  );
  if (matches.length > 1) throw new Error("Work schedule periods overlap");
  return matches[0] ?? null;
}

export function scheduledMinutesFor(person: PersonPlan, date: DateOrdinal): number {
  if (date < person.activeFrom || (person.activeUntil !== undefined && date > person.activeUntil))
    return 0;
  const schedule = scheduleFor(person.schedules, date);
  const minutes = schedule?.weekdayMinutes[isoWeekday(date)] ?? 0;
  assertMinutes(minutes, "Scheduled capacity");
  return minutes;
}

export function calculateDay(
  person: PersonPlan,
  date: DateOrdinal,
  scenario: Scenario = "confirmed_and_tentative",
): DailyCapacity {
  const scheduledMinutes = scheduledMinutesFor(person, date);
  const holiday = person.holidays.has(date);
  const requestedLeave = holiday
    ? 0
    : person.leave
        .filter((entry) => entry.start <= date && entry.end >= date)
        .reduce((total, entry) => total + (entry.minutesPerDay ?? scheduledMinutes), 0);
  const leaveMinutes = Math.min(scheduledMinutes, requestedLeave);
  const capacityMinutes = holiday ? 0 : Math.max(0, scheduledMinutes - leaveMinutes);
  const activeAllocations = person.allocations.filter(
    (allocation) => allocation.start <= date && allocation.end >= date,
  );
  let confirmedMinutes = 0;
  let tentativeMinutes = 0;
  let tentativeBillableMinutes = 0;
  let tentativeInternalMinutes = 0;
  let billableConfirmedMinutes = 0;
  let internalConfirmedMinutes = 0;
  for (const allocation of activeAllocations) {
    const minutes = allocationMinutes(allocation, scheduledMinutes);
    if (allocation.state === "confirmed") {
      confirmedMinutes += minutes;
      if (allocation.kind === "billable") billableConfirmedMinutes += minutes;
      else internalConfirmedMinutes += minutes;
    } else {
      tentativeMinutes += minutes;
      if (allocation.kind === "billable") tentativeBillableMinutes += minutes;
      else tentativeInternalMinutes += minutes;
    }
  }
  const scenarioMinutes =
    confirmedMinutes + (scenario === "confirmed_and_tentative" ? tentativeMinutes : 0);
  return {
    personId: person.id,
    date,
    scheduledMinutes,
    leaveMinutes,
    capacityMinutes,
    confirmedMinutes,
    tentativeMinutes,
    tentativeBillableMinutes,
    tentativeInternalMinutes,
    billableConfirmedMinutes,
    internalConfirmedMinutes,
    availableConfirmedMinutes: Math.max(0, capacityMinutes - confirmedMinutes),
    availableScenarioMinutes: Math.max(0, capacityMinutes - scenarioMinutes),
    confirmedOverbookMinutes: Math.max(0, confirmedMinutes - capacityMinutes),
    potentialOverbookMinutes: Math.max(0, confirmedMinutes + tentativeMinutes - capacityMinutes),
    billableUtilizationPercent:
      capacityMinutes === 0 ? null : roundHalfUp(billableConfirmedMinutes * 100, capacityMinutes),
    internalUtilizationPercent:
      capacityMinutes === 0 ? null : roundHalfUp(internalConfirmedMinutes * 100, capacityMinutes),
  };
}

export function calculateRange(
  person: PersonPlan,
  start: DateOrdinal,
  end: DateOrdinal,
  scenario: Scenario,
): DailyCapacity[] {
  return eachDate(start, end).map((date) => calculateDay(person, date, scenario));
}

export function aggregateCapacity(days: readonly DailyCapacity[]): CapacityAggregate {
  const totals = days.reduce(
    (sum, day) => ({
      capacityMinutes: sum.capacityMinutes + day.capacityMinutes,
      confirmedMinutes: sum.confirmedMinutes + day.confirmedMinutes,
      tentativeMinutes: sum.tentativeMinutes + day.tentativeMinutes,
      tentativeBillableMinutes: sum.tentativeBillableMinutes + day.tentativeBillableMinutes,
      tentativeInternalMinutes: sum.tentativeInternalMinutes + day.tentativeInternalMinutes,
      billableConfirmedMinutes: sum.billableConfirmedMinutes + day.billableConfirmedMinutes,
      internalConfirmedMinutes: sum.internalConfirmedMinutes + day.internalConfirmedMinutes,
    }),
    {
      capacityMinutes: 0,
      confirmedMinutes: 0,
      tentativeMinutes: 0,
      tentativeBillableMinutes: 0,
      tentativeInternalMinutes: 0,
      billableConfirmedMinutes: 0,
      internalConfirmedMinutes: 0,
    },
  );
  return {
    ...totals,
    billableUtilizationPercent:
      totals.capacityMinutes === 0
        ? null
        : roundHalfUp(totals.billableConfirmedMinutes * 100, totals.capacityMinutes),
    internalUtilizationPercent:
      totals.capacityMinutes === 0
        ? null
        : roundHalfUp(totals.internalConfirmedMinutes * 100, totals.capacityMinutes),
  };
}

export function calculateForecastWeek(
  weekStart: DateOrdinal,
  days: readonly DailyCapacity[],
  billableTargetPercent: number,
): ForecastWeek {
  if (
    !Number.isInteger(billableTargetPercent) ||
    billableTargetPercent < 0 ||
    billableTargetPercent > 100
  ) {
    throw new Error("Billable target percent must be an integer from 0 to 100");
  }
  const total = days.reduce(
    (sum, day) => ({
      capacity: sum.capacity + day.capacityMinutes,
      confirmedBillable: sum.confirmedBillable + day.billableConfirmedMinutes,
      confirmedInternal: sum.confirmedInternal + day.internalConfirmedMinutes,
      tentativeBillable: sum.tentativeBillable + day.tentativeBillableMinutes,
      tentativeInternal: sum.tentativeInternal + day.tentativeInternalMinutes,
      confirmedOverbook: sum.confirmedOverbook + day.confirmedOverbookMinutes,
      potentialOverbook: sum.potentialOverbook + day.potentialOverbookMinutes,
    }),
    {
      capacity: 0,
      confirmedBillable: 0,
      confirmedInternal: 0,
      tentativeBillable: 0,
      tentativeInternal: 0,
      confirmedOverbook: 0,
      potentialOverbook: 0,
    },
  );
  const confirmed = total.confirmedBillable + total.confirmedInternal;
  const potential = confirmed + total.tentativeBillable + total.tentativeInternal;
  const targetMinutes =
    total.capacity === 0 ? 0 : roundHalfUp(total.capacity * billableTargetPercent, 100);
  return {
    weekStart,
    capacityMinutes: total.capacity,
    confirmedBillableMinutes: total.confirmedBillable,
    confirmedInternalMinutes: total.confirmedInternal,
    tentativeBillableMinutes: total.tentativeBillable,
    tentativeInternalMinutes: total.tentativeInternal,
    confirmedUtilizationPercent:
      total.capacity === 0 ? null : roundHalfUp(confirmed * 100, total.capacity),
    potentialUtilizationPercent:
      total.capacity === 0 ? null : roundHalfUp(potential * 100, total.capacity),
    confirmedOverbookMinutes: total.confirmedOverbook,
    potentialOverbookMinutes: total.potentialOverbook,
    billableTargetGapMinutes: Math.max(0, targetMinutes - total.confirmedBillable),
  };
}

function fingerprint(input: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function deriveConflicts(days: readonly DailyCapacity[]): CapacityConflict[] {
  return days.flatMap((day) => {
    const severity =
      day.confirmedOverbookMinutes > 0
        ? "confirmed"
        : day.potentialOverbookMinutes > 0
          ? "potential"
          : null;
    if (!severity) return [];
    const overbookMinutes =
      severity === "confirmed" ? day.confirmedOverbookMinutes : day.potentialOverbookMinutes;
    return [
      {
        personId: day.personId,
        date: day.date,
        severity,
        overbookMinutes,
        fingerprint: fingerprint(
          `${day.personId}|${day.date}|${severity}|${day.capacityMinutes}|${day.confirmedMinutes}|${day.tentativeMinutes}`,
        ),
      },
    ];
  });
}

function matches(person: PersonPlan, request: EarliestStartRequest): boolean {
  if (request.roleId && person.roleId !== request.roleId) return false;
  if (request.teamId && person.teamId !== request.teamId) return false;
  return (request.tags ?? []).every((tag) => person.tags.includes(tag));
}

export function findEarliestStarts(
  people: readonly PersonPlan[],
  request: EarliestStartRequest,
): EarliestStartResult[] {
  if (!Number.isInteger(request.workdayCount) || request.workdayCount <= 0)
    throw new Error("Workday count must be positive");
  assertMinutes(request.dailyLoadMinutes, "Daily load");
  if (
    !Number.isInteger(request.horizonDays) ||
    request.horizonDays < 1 ||
    request.horizonDays > 730
  ) {
    throw new Error("Search horizon must be between 1 and 730 days");
  }
  const horizonEnd = addDays(request.notBefore, request.horizonDays - 1);
  return people
    .filter((person) => matches(person, request))
    .flatMap((person) => {
      for (
        let candidate = request.notBefore;
        candidate <= horizonEnd;
        candidate = addDays(candidate, 1)
      ) {
        let count = 0;
        let first: DateOrdinal | null = null;
        let last: DateOrdinal | null = null;
        for (let date = candidate; date <= horizonEnd; date = addDays(date, 1)) {
          const day = calculateDay(person, date, request.scenario);
          const available =
            request.scenario === "confirmed"
              ? day.availableConfirmedMinutes
              : day.availableScenarioMinutes;
          if (day.capacityMinutes > 0 && available >= request.dailyLoadMinutes) {
            first ??= date;
            last = date;
            count += 1;
            if (count === request.workdayCount && first !== null && last !== null) {
              return [{ personId: person.id, start: first, end: last }];
            }
          } else if (day.scheduledMinutes > 0 && day.capacityMinutes > 0) {
            break;
          } else if (last !== null && date - last > 7) {
            break;
          }
        }
      }
      return [];
    })
    .sort(
      (left, right) =>
        left.start - right.start ||
        left.end - right.end ||
        left.personId.localeCompare(right.personId),
    );
}
