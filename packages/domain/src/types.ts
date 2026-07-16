import type { DateOrdinal } from "./dates.js";

export type AllocationState = "confirmed" | "tentative";
export type AllocationMode = "minutes_per_day" | "capacity_percent";
export type Scenario = "confirmed" | "confirmed_and_tentative";
export type ProjectKind = "billable" | "internal";

export interface WorkScheduleVersion {
  effectiveFrom: DateOrdinal;
  effectiveUntil?: DateOrdinal;
  weekdayMinutes: Readonly<Record<1 | 2 | 3 | 4 | 5 | 6 | 7, number>>;
}

export interface LeaveDeduction {
  start: DateOrdinal;
  end: DateOrdinal;
  minutesPerDay?: number;
}

export interface Allocation {
  id: string;
  projectId: string;
  start: DateOrdinal;
  end: DateOrdinal;
  mode: AllocationMode;
  minutesPerDay?: number;
  capacityPercent?: number;
  state: AllocationState;
  kind: ProjectKind;
}

export interface PersonPlan {
  id: string;
  activeFrom: DateOrdinal;
  activeUntil?: DateOrdinal;
  roleId?: string;
  teamId?: string;
  tags: readonly string[];
  schedules: readonly WorkScheduleVersion[];
  holidays: ReadonlySet<DateOrdinal>;
  leave: readonly LeaveDeduction[];
  allocations: readonly Allocation[];
}

export interface DailyCapacity {
  personId: string;
  date: DateOrdinal;
  scheduledMinutes: number;
  leaveMinutes: number;
  capacityMinutes: number;
  confirmedMinutes: number;
  tentativeMinutes: number;
  tentativeBillableMinutes: number;
  tentativeInternalMinutes: number;
  billableConfirmedMinutes: number;
  internalConfirmedMinutes: number;
  availableConfirmedMinutes: number;
  availableScenarioMinutes: number;
  confirmedOverbookMinutes: number;
  potentialOverbookMinutes: number;
  billableUtilizationPercent: number | null;
  internalUtilizationPercent: number | null;
}

export interface CapacityAggregate {
  capacityMinutes: number;
  confirmedMinutes: number;
  tentativeMinutes: number;
  tentativeBillableMinutes: number;
  tentativeInternalMinutes: number;
  billableConfirmedMinutes: number;
  internalConfirmedMinutes: number;
  billableUtilizationPercent: number | null;
  internalUtilizationPercent: number | null;
}

export interface CapacityConflict {
  personId: string;
  date: DateOrdinal;
  severity: "confirmed" | "potential";
  overbookMinutes: number;
  fingerprint: string;
}

export interface EarliestStartRequest {
  notBefore: DateOrdinal;
  workdayCount: number;
  dailyLoadMinutes: number;
  scenario: Scenario;
  horizonDays: number;
  roleId?: string;
  teamId?: string;
  tags?: readonly string[];
}

export interface EarliestStartResult {
  personId: string;
  start: DateOrdinal;
  end: DateOrdinal;
  continuousAllocationSafe: boolean;
}

export interface ForecastWeek {
  weekStart: DateOrdinal;
  capacityMinutes: number;
  confirmedBillableMinutes: number;
  confirmedInternalMinutes: number;
  tentativeBillableMinutes: number;
  tentativeInternalMinutes: number;
  confirmedUtilizationPercent: number | null;
  potentialUtilizationPercent: number | null;
  confirmedOverbookMinutes: number;
  potentialOverbookMinutes: number;
  billableTargetGapMinutes: number;
}
