import { describe, expect, it } from "vitest";
import type { ScheduleResponse } from "./api";
import { planningPeriod, startFinderNotBefore, summarizeScheduleWeek } from "./planning-calendar";

describe("organization planning calendar", () => {
  it("derives period boundaries from organization time and ISO week start", () => {
    expect(planningPeriod(new Date("2030-01-07T20:30:00Z"), "Asia/Dhaka", 7, 0, 4)).toEqual({
      today: "2030-01-08",
      start: "2030-01-06",
      end: "2030-02-02",
      weeks: ["2030-01-06", "2030-01-13", "2030-01-20", "2030-01-27"],
    });
    expect(
      planningPeriod(new Date("2030-01-08T01:30:00Z"), "America/Los_Angeles", 1, 0, 4),
    ).toMatchObject({ today: "2030-01-07", start: "2030-01-07", end: "2030-02-03" });
  });

  it("clamps Start Finder to organization today for current and past periods", () => {
    const instant = new Date("2030-01-07T12:00:00Z");
    const current = planningPeriod(instant, "UTC", 1, 0, 4);
    const past = planningPeriod(instant, "UTC", 1, -4, 4);
    const future = planningPeriod(instant, "UTC", 1, 4, 4);
    expect(current).toMatchObject({ today: "2030-01-07", start: "2030-01-07" });
    expect(startFinderNotBefore(current)).toBe("2030-01-07");
    expect(past).toMatchObject({ today: "2030-01-07", start: "2029-12-10" });
    expect(startFinderNotBefore(past)).toBe("2030-01-07");
    expect(future).toMatchObject({ today: "2030-01-07", start: "2030-02-04" });
    expect(startFinderNotBefore(future)).toBe("2030-02-04");
  });

  it("summarizes only the requested displayed week", () => {
    const schedule = {
      start: "2030-01-06",
      end: "2030-02-02",
      scenario: "confirmed_and_tentative",
      people: [
        {
          personId: "first",
          days: [
            {
              date: "2030-01-08",
              confirmedMinutes: 60,
              tentativeMinutes: 30,
              availableConfirmedMinutes: 420,
              availableScenarioMinutes: 390,
            },
          ],
        },
        {
          personId: "second",
          days: [
            {
              date: "2030-01-15",
              confirmedMinutes: 480,
              tentativeMinutes: 0,
              availableConfirmedMinutes: 0,
              availableScenarioMinutes: 0,
            },
          ],
        },
      ],
      conflicts: [
        { date: "2030-01-08", severity: "potential" },
        { date: "2030-01-15", severity: "confirmed" },
      ],
    } as ScheduleResponse;

    expect(
      summarizeScheduleWeek(schedule, "2030-01-06", "2030-01-12", "confirmed_and_tentative"),
    ).toEqual({ scheduledPeople: 1, conflictCount: 1, availableMinutes: 390 });
    expect(summarizeScheduleWeek(schedule, "2030-01-06", "2030-01-12", "confirmed")).toEqual({
      scheduledPeople: 1,
      conflictCount: 0,
      availableMinutes: 420,
    });
  });
});
