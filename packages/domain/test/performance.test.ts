import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  type Allocation,
  addDays,
  calculateRange,
  type PersonPlan,
  parseLocalDate,
} from "../src/index.js";

describe("documented local reference performance", () => {
  it("calculates 100 people, 2,000 allocations, and 52 weeks under 1.5 seconds", () => {
    const start = parseLocalDate("2030-01-07");
    const allocations: Allocation[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `allocation-${index}`,
      projectId: `project-${index % 50}`,
      start: addDays(start, index % 300),
      end: addDays(start, Math.min(363, (index % 300) + 20)),
      mode: "minutes_per_day",
      minutesPerDay: 30,
      state: index % 3 === 0 ? "tentative" : "confirmed",
      kind: index % 4 === 0 ? "internal" : "billable",
    }));
    const people: PersonPlan[] = Array.from({ length: 100 }, (_, index) => ({
      id: `person-${index}`,
      activeFrom: start,
      tags: [],
      schedules: [
        {
          effectiveFrom: start,
          weekdayMinutes: { 1: 480, 2: 480, 3: 480, 4: 480, 5: 480, 6: 0, 7: 0 },
        },
      ],
      holidays: new Set(),
      leave: [],
      allocations: allocations.filter((_, allocationIndex) => allocationIndex % 100 === index),
    }));
    const began = performance.now();
    const days = people.flatMap((person) =>
      calculateRange(person, start, addDays(start, 363), "confirmed_and_tentative"),
    );
    const elapsed = performance.now() - began;
    expect(days).toHaveLength(36_400);
    expect(elapsed).toBeLessThan(1_500);
    console.log(
      `Domain performance smoke: ${elapsed.toFixed(1)}ms for 100 people / 2,000 allocations / 52 weeks.`,
    );
  });
});
