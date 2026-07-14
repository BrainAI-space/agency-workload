import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addDays,
  aggregateCapacity,
  calculateDay,
  formatLocalDate,
  type PersonPlan,
  parseLocalDate,
} from "../src/index.js";

const seed = 20260714;
const monday = parseLocalDate("2030-01-07");

describe("capacity invariants", () => {
  it("holds integer-minute and conservation invariants for 1,000 generated plans", () => {
    fc.assert(
      fc.property(
        fc.record({
          scheduled: fc.integer({ min: 0, max: 900 }),
          leave: fc.integer({ min: 0, max: 1_200 }),
          confirmed: fc.integer({ min: 0, max: 1_200 }),
          tentative: fc.integer({ min: 0, max: 1_200 }),
          percent: fc.integer({ min: 1, max: 1_000 }),
        }),
        ({ scheduled, leave, confirmed, tentative, percent }) => {
          const person: PersonPlan = {
            id: "property-person",
            activeFrom: monday,
            tags: [],
            schedules: [
              {
                effectiveFrom: monday,
                weekdayMinutes: {
                  1: scheduled,
                  2: scheduled,
                  3: scheduled,
                  4: scheduled,
                  5: scheduled,
                  6: 0,
                  7: 0,
                },
              },
            ],
            holidays: new Set(),
            leave: [{ start: monday, end: monday, minutesPerDay: leave }],
            allocations: [
              {
                id: "confirmed",
                projectId: "billable",
                start: monday,
                end: monday,
                mode: "minutes_per_day",
                minutesPerDay: confirmed,
                state: "confirmed",
                kind: "billable",
              },
              {
                id: "tentative",
                projectId: "tentative",
                start: monday,
                end: monday,
                mode: "minutes_per_day",
                minutesPerDay: tentative,
                state: "tentative",
                kind: "internal",
              },
              {
                id: "percent",
                projectId: "percent",
                start: monday,
                end: monday,
                mode: "capacity_percent",
                capacityPercent: percent,
                state: "confirmed",
                kind: "billable",
              },
            ],
          };
          const day = calculateDay(person, monday);
          expect(Number.isInteger(day.capacityMinutes)).toBe(true);
          expect(day.capacityMinutes).toBe(Math.max(0, scheduled - Math.min(scheduled, leave)));
          expect(
            day.availableConfirmedMinutes + Math.min(day.confirmedMinutes, day.capacityMinutes),
          ).toBe(day.capacityMinutes);
          const percentageDemand =
            scheduled === 0 ? 0 : Math.floor((scheduled * percent + 50) / 100);
          const fixedConfirmedDemand = scheduled === 0 ? 0 : confirmed;
          const tentativeDemand = scheduled === 0 ? 0 : tentative;
          expect(day.confirmedMinutes).toBe(fixedConfirmedDemand + percentageDemand);
          expect(day.confirmedOverbookMinutes).toBe(
            Math.max(0, day.confirmedMinutes - day.capacityMinutes),
          );
          expect(day.potentialOverbookMinutes).toBe(
            Math.max(
              0,
              fixedConfirmedDemand + percentageDemand + tentativeDemand - day.capacityMinutes,
            ),
          );
        },
      ),
      { numRuns: 1_000, seed },
    );
  });

  it("round-trips 1,000 calendar ordinals and aggregates by summed minutes", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (offset) => {
        const date = addDays(monday, offset);
        expect(parseLocalDate(formatLocalDate(date))).toBe(date);
      }),
      { numRuns: 1_000, seed: seed + 1 },
    );
    expect(aggregateCapacity([])).toEqual({
      capacityMinutes: 0,
      confirmedMinutes: 0,
      tentativeMinutes: 0,
      billableConfirmedMinutes: 0,
      internalConfirmedMinutes: 0,
      billableUtilizationPercent: null,
      internalUtilizationPercent: null,
    });
  });
});
