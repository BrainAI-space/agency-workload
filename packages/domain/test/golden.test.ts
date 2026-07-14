import { describe, expect, it } from "vitest";
import {
  type Allocation,
  addDays,
  aggregateCapacity,
  calculateDay,
  type DateOrdinal,
  deriveConflicts,
  findEarliestStarts,
  formatLocalDate,
  isoWeekday,
  type PersonPlan,
  parseLocalDate,
  plannerDateForInstant,
  roundHalfUp,
  type WorkScheduleVersion,
} from "../src/index.js";

const monday = parseLocalDate("2030-01-07");
const weekdays = (minutes = 480): WorkScheduleVersion["weekdayMinutes"] => ({
  1: minutes,
  2: minutes,
  3: minutes,
  4: minutes,
  5: minutes,
  6: 0,
  7: 0,
});

function allocation(overrides: Partial<Allocation> = {}): Allocation {
  return {
    id: "allocation",
    projectId: "project",
    start: monday,
    end: monday,
    mode: "minutes_per_day",
    minutesPerDay: 120,
    state: "confirmed",
    kind: "billable",
    ...overrides,
  };
}

function person(overrides: Partial<PersonPlan> = {}): PersonPlan {
  return {
    id: "person-a",
    activeFrom: monday,
    tags: ["typescript", "api"],
    roleId: "developer",
    teamId: "delivery",
    schedules: [{ effectiveFrom: monday, weekdayMinutes: weekdays() }],
    holidays: new Set<DateOrdinal>(),
    leave: [],
    allocations: [],
    ...overrides,
  };
}

describe("22 supplied-rule golden calculation cases", () => {
  it("01 parses and formats leap dates without timestamps", () => {
    expect(formatLocalDate(parseLocalDate("2028-02-29"))).toBe("2028-02-29");
  });
  it("02 rejects invalid or non-padded planner dates", () => {
    for (const value of ["2029-02-29", "2030-1-07", "2030-01-7", "2030-13-01"]) {
      expect(() => parseLocalDate(value)).toThrow();
    }
  });
  it("03 derives ISO weekdays in calendar space", () => {
    expect(isoWeekday(monday)).toBe(1);
    expect(isoWeekday(addDays(monday, 6))).toBe(7);
  });
  it("04 applies the effective weekly work schedule", () => {
    expect(calculateDay(person(), monday).capacityMinutes).toBe(480);
  });
  it("05 selects a later effective schedule version", () => {
    const changed = person({
      schedules: [
        {
          effectiveFrom: monday,
          effectiveUntil: addDays(monday, 6),
          weekdayMinutes: weekdays(480),
        },
        { effectiveFrom: addDays(monday, 7), weekdayMinutes: weekdays(360) },
      ],
    });
    expect(calculateDay(changed, addDays(monday, 7)).capacityMinutes).toBe(360);
  });
  it("06 returns zero outside the person active range", () => {
    expect(calculateDay(person({ activeFrom: addDays(monday, 1) }), monday).capacityMinutes).toBe(
      0,
    );
  });
  it("07 deducts a holiday once", () => {
    expect(calculateDay(person({ holidays: new Set([monday]) }), monday).capacityMinutes).toBe(0);
  });
  it("08 deducts partial leave in minutes", () => {
    const day = calculateDay(
      person({ leave: [{ start: monday, end: monday, minutesPerDay: 120 }] }),
      monday,
    );
    expect(day).toMatchObject({ leaveMinutes: 120, capacityMinutes: 360 });
  });
  it("09 caps overlapping leave and does not create negative capacity", () => {
    const day = calculateDay(
      person({
        leave: [
          { start: monday, end: monday },
          { start: monday, end: monday, minutesPerDay: 240 },
        ],
      }),
      monday,
    );
    expect(day).toMatchObject({ leaveMinutes: 480, capacityMinutes: 0 });
  });
  it("10 does not double-count leave on a holiday", () => {
    const day = calculateDay(
      person({ holidays: new Set([monday]), leave: [{ start: monday, end: monday }] }),
      monday,
    );
    expect(day).toMatchObject({ leaveMinutes: 0, capacityMinutes: 0 });
  });
  it("11 uses inclusive allocation dates", () => {
    const plan = person({ allocations: [allocation({ end: addDays(monday, 1) })] });
    expect(calculateDay(plan, addDays(monday, 1)).confirmedMinutes).toBe(120);
  });
  it("12 keeps confirmed and tentative minutes distinct", () => {
    const day = calculateDay(
      person({
        allocations: [
          allocation(),
          allocation({ id: "tentative", state: "tentative", minutesPerDay: 90 }),
        ],
      }),
      monday,
    );
    expect(day).toMatchObject({ confirmedMinutes: 120, tentativeMinutes: 90 });
  });
  it("13 rounds capacity-percent allocations half up", () => {
    const day = calculateDay(
      person({
        schedules: [{ effectiveFrom: monday, weekdayMinutes: weekdays(455) }],
        allocations: [allocation({ mode: "capacity_percent", capacityPercent: 50 })],
      }),
      monday,
    );
    expect(day.confirmedMinutes).toBe(228);
    expect(roundHalfUp(22750, 100)).toBe(228);
  });
  it("14 derives confirmed overbook", () => {
    expect(
      calculateDay(person({ allocations: [allocation({ minutesPerDay: 600 })] }), monday)
        .confirmedOverbookMinutes,
    ).toBe(120);
  });
  it("15 derives potential overbook from tentative work", () => {
    const day = calculateDay(
      person({
        allocations: [
          allocation({ minutesPerDay: 400 }),
          allocation({ id: "tentative", state: "tentative", minutesPerDay: 180 }),
        ],
      }),
      monday,
    );
    expect(day).toMatchObject({ confirmedOverbookMinutes: 0, potentialOverbookMinutes: 100 });
  });
  it("16 reports billable and internal utilization separately", () => {
    const day = calculateDay(
      person({
        allocations: [
          allocation({ minutesPerDay: 240 }),
          allocation({ id: "internal", kind: "internal", minutesPerDay: 120 }),
        ],
      }),
      monday,
    );
    expect(day).toMatchObject({ billableUtilizationPercent: 50, internalUtilizationPercent: 25 });
  });
  it("17 reports zero-capacity utilization as N/A", () => {
    expect(calculateDay(person(), addDays(monday, 5)).billableUtilizationPercent).toBeNull();
  });
  it("18 aggregates minutes before computing percentages", () => {
    const first = calculateDay(
      person({
        schedules: [{ effectiveFrom: monday, weekdayMinutes: weekdays(480) }],
        allocations: [allocation({ minutesPerDay: 240 })],
      }),
      monday,
    );
    const secondDate = addDays(monday, 1);
    const second = calculateDay(
      person({
        schedules: [{ effectiveFrom: monday, weekdayMinutes: weekdays(120) }],
        allocations: [allocation({ start: secondDate, end: secondDate, minutesPerDay: 120 })],
      }),
      secondDate,
    );
    expect(aggregateCapacity([first, second]).billableUtilizationPercent).toBe(60);
  });
  it("19 derives stable conflict fingerprints", () => {
    const days = [
      calculateDay(person({ allocations: [allocation({ minutesPerDay: 600 })] }), monday),
    ];
    expect(deriveConflicts(days)[0]?.fingerprint).toBe(deriveConflicts(days)[0]?.fingerprint);
    expect(deriveConflicts(days)[0]).toMatchObject({ severity: "confirmed", overbookMinutes: 120 });
  });
  it("20 finds the earliest filtered person", () => {
    const result = findEarliestStarts([person(), person({ id: "wrong", roleId: "designer" })], {
      notBefore: monday,
      workdayCount: 2,
      dailyLoadMinutes: 240,
      scenario: "confirmed",
      horizonDays: 30,
      roleId: "developer",
      teamId: "delivery",
      tags: ["typescript"],
    });
    expect(result).toEqual([{ personId: "person-a", start: monday, end: addDays(monday, 1) }]);
  });
  it("21 extends earliest completion across weekends and holidays", () => {
    const friday = parseLocalDate("2030-01-11");
    const mondayAfter = addDays(friday, 3);
    const plan = person({
      activeFrom: friday,
      schedules: [{ effectiveFrom: friday, weekdayMinutes: weekdays() }],
      holidays: new Set([mondayAfter]),
    });
    const result = findEarliestStarts([plan], {
      notBefore: friday,
      workdayCount: 2,
      dailyLoadMinutes: 60,
      scenario: "confirmed",
      horizonDays: 14,
    });
    const match = result[0];
    if (!match) throw new Error("earliest-start match unavailable");
    expect(formatLocalDate(match.end)).toBe("2030-01-15");
  });
  it("22 breaks a sequence after a gap longer than seven days and respects tentative scenario", () => {
    const plan = person({
      holidays: new Set(Array.from({ length: 8 }, (_, index) => addDays(monday, index + 1))),
      allocations: [allocation({ state: "tentative", minutesPerDay: 480 })],
    });
    const result = findEarliestStarts([plan], {
      notBefore: monday,
      workdayCount: 2,
      dailyLoadMinutes: 60,
      scenario: "confirmed_and_tentative",
      horizonDays: 20,
    });
    expect(result[0]?.start).toBeGreaterThan(addDays(monday, 8));
  });
});

describe("baseline allocation demand review cases", () => {
  it("uses baseline scheduled minutes for 50 percent allocation with partial leave", () => {
    const day = calculateDay(
      person({
        leave: [{ start: monday, end: monday, minutesPerDay: 120 }],
        allocations: [allocation({ mode: "capacity_percent", capacityPercent: 50 })],
      }),
      monday,
    );
    expect(day).toMatchObject({
      scheduledMinutes: 480,
      capacityMinutes: 360,
      confirmedMinutes: 240,
      confirmedOverbookMinutes: 0,
    });
  });

  it("keeps 50 percent demand on a holiday and derives conflict", () => {
    const day = calculateDay(
      person({
        holidays: new Set([monday]),
        allocations: [allocation({ mode: "capacity_percent", capacityPercent: 50 })],
      }),
      monday,
    );
    expect(day).toMatchObject({ scheduledMinutes: 480, capacityMinutes: 0, confirmedMinutes: 240 });
    expect(day.confirmedOverbookMinutes).toBe(240);
  });

  it("keeps fixed-minute demand on a holiday", () => {
    const day = calculateDay(
      person({ holidays: new Set([monday]), allocations: [allocation({ minutesPerDay: 300 })] }),
      monday,
    );
    expect(day).toMatchObject({ scheduledMinutes: 480, capacityMinutes: 0, confirmedMinutes: 300 });
  });

  it("sets fixed and percentage demand to zero on baseline-zero weekends", () => {
    const saturday = addDays(monday, 5);
    const day = calculateDay(
      person({
        allocations: [
          allocation({ id: "fixed", start: saturday, end: saturday, minutesPerDay: 300 }),
          allocation({
            id: "percent",
            start: saturday,
            end: saturday,
            mode: "capacity_percent",
            capacityPercent: 50,
          }),
        ],
      }),
      saturday,
    );
    expect(day).toMatchObject({ scheduledMinutes: 0, capacityMinutes: 0, confirmedMinutes: 0 });
  });
});

describe("organization-local planner dates", () => {
  it("derives a previous planner date in America/Los_Angeles when UTC has advanced", () => {
    expect(plannerDateForInstant(new Date("2030-01-08T01:30:00Z"), "America/Los_Angeles")).toBe(
      "2030-01-07",
    );
  });

  it("derives a next planner date in Asia/Dhaka before UTC midnight", () => {
    expect(plannerDateForInstant(new Date("2030-01-07T20:30:00Z"), "Asia/Dhaka")).toBe(
      "2030-01-08",
    );
  });

  it("rejects unsafe or unknown timezone identifiers", () => {
    expect(() => plannerDateForInstant(new Date(), "../../UTC")).toThrow();
    expect(() => plannerDateForInstant(new Date(), "Unknown/Nowhere")).toThrow();
  });
});
