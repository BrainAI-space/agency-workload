import { describe, expect, it } from "vitest";
import { calculateForecastWeek, type DailyCapacity, parseLocalDate } from "../src/index.js";

const weekStart = parseLocalDate("2030-01-07");

function day(overrides: Partial<DailyCapacity> = {}): DailyCapacity {
  return {
    personId: "person",
    date: weekStart,
    scheduledMinutes: 480,
    leaveMinutes: 0,
    capacityMinutes: 480,
    confirmedMinutes: 300,
    tentativeMinutes: 120,
    billableConfirmedMinutes: 240,
    internalConfirmedMinutes: 60,
    tentativeBillableMinutes: 90,
    tentativeInternalMinutes: 30,
    availableConfirmedMinutes: 180,
    availableScenarioMinutes: 60,
    confirmedOverbookMinutes: 0,
    potentialOverbookMinutes: 0,
    billableUtilizationPercent: 50,
    internalUtilizationPercent: 13,
    ...overrides,
  };
}

describe("weekly advisory forecast", () => {
  it("sums minute categories before calculating utilization and target gap", () => {
    const forecast = calculateForecastWeek(weekStart, [day(), day({ capacityMinutes: 120 })], 75);
    expect(forecast).toEqual({
      weekStart,
      capacityMinutes: 600,
      confirmedBillableMinutes: 480,
      confirmedInternalMinutes: 120,
      tentativeBillableMinutes: 180,
      tentativeInternalMinutes: 60,
      confirmedUtilizationPercent: 100,
      potentialUtilizationPercent: 140,
      confirmedOverbookMinutes: 0,
      potentialOverbookMinutes: 0,
      billableTargetGapMinutes: 0,
    });
  });

  it("returns N/A utilization and zero gap for zero capacity", () => {
    expect(calculateForecastWeek(weekStart, [day({ capacityMinutes: 0 })], 75)).toMatchObject({
      confirmedUtilizationPercent: null,
      potentialUtilizationPercent: null,
      billableTargetGapMinutes: 0,
    });
  });
});
