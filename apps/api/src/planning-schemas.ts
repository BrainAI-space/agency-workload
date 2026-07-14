import { type TSchema, Type } from "@sinclair/typebox";

const Uuid = Type.String({ format: "uuid" });
const DateOnly = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const NullableUuid = Type.Union([Uuid, Type.Null()]);
const NullableDate = Type.Union([DateOnly, Type.Null()]);
const ErrorResponse = Type.Object({ error: Type.String() }, { additionalProperties: false });

export function planningResponses(success: TSchema) {
  return {
    200: success,
    400: ErrorResponse,
    401: ErrorResponse,
    403: ErrorResponse,
    404: ErrorResponse,
    409: ErrorResponse,
    415: ErrorResponse,
  };
}

export const PlanningSettingsResponse = Type.Object(
  {
    timezone: Type.String(),
    weekStartsOn: Type.Integer(),
    dateFormat: Type.String(),
    forecastHorizonWeeks: Type.Integer(),
    billableTargetPercent: Type.Integer(),
    rowVersion: Type.Integer(),
  },
  { additionalProperties: false },
);

export const PersonResponse = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    email: Type.Optional(Type.String()),
    teamId: NullableUuid,
    deliveryRoleId: NullableUuid,
    activeFrom: DateOnly,
    activeUntil: NullableDate,
    rowVersion: Type.Integer(),
  },
  { additionalProperties: false },
);
const ScheduleResponse = Type.Object(
  {
    id: Uuid,
    effectiveFrom: DateOnly,
    effectiveUntil: NullableDate,
    weekdays: Type.Array(
      Type.Object(
        { isoWeekday: Type.Integer(), minutes: Type.Integer() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
export const PersonDetailResponse = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    email: Type.Optional(Type.String()),
    teamId: NullableUuid,
    deliveryRoleId: NullableUuid,
    activeFrom: DateOnly,
    activeUntil: NullableDate,
    rowVersion: Type.Integer(),
    schedules: Type.Array(ScheduleResponse),
  },
  { additionalProperties: false },
);
export const PersonListResponse = Type.Array(PersonResponse);

export const ProjectResponse = Type.Object(
  {
    id: Uuid,
    clientId: NullableUuid,
    name: Type.String(),
    kind: Type.Union([Type.Literal("billable"), Type.Literal("internal")]),
    status: Type.Union([
      Type.Literal("draft"),
      Type.Literal("tentative"),
      Type.Literal("confirmed"),
      Type.Literal("completed"),
      Type.Literal("cancelled"),
    ]),
    targetStart: NullableDate,
    targetEnd: NullableDate,
    rowVersion: Type.Integer(),
    completedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);
export const ProjectListResponse = Type.Array(ProjectResponse);

export const AllocationResponse = Type.Object(
  {
    id: Uuid,
    personId: Uuid,
    projectId: Uuid,
    startDate: DateOnly,
    endDate: DateOnly,
    mode: Type.Union([Type.Literal("minutes_per_day"), Type.Literal("capacity_percent")]),
    minutesPerDay: Type.Union([Type.Integer(), Type.Null()]),
    capacityPercent: Type.Union([Type.Integer(), Type.Null()]),
    state: Type.Union([Type.Literal("confirmed"), Type.Literal("tentative")]),
    rowVersion: Type.Integer(),
    kind: Type.Optional(Type.Union([Type.Literal("billable"), Type.Literal("internal")])),
  },
  { additionalProperties: false },
);
export const AllocationListResponse = Type.Array(AllocationResponse);

const DailyCapacityResponse = Type.Object(
  {
    personId: Uuid,
    date: DateOnly,
    scheduledMinutes: Type.Integer(),
    leaveMinutes: Type.Integer(),
    capacityMinutes: Type.Integer(),
    confirmedMinutes: Type.Integer(),
    tentativeMinutes: Type.Integer(),
    billableConfirmedMinutes: Type.Integer(),
    internalConfirmedMinutes: Type.Integer(),
    availableConfirmedMinutes: Type.Integer(),
    availableScenarioMinutes: Type.Integer(),
    confirmedOverbookMinutes: Type.Integer(),
    potentialOverbookMinutes: Type.Integer(),
    billableUtilizationPercent: Type.Union([Type.Integer(), Type.Null()]),
    internalUtilizationPercent: Type.Union([Type.Integer(), Type.Null()]),
  },
  { additionalProperties: false },
);
const ConflictResponse = Type.Object(
  {
    personId: Uuid,
    date: DateOnly,
    severity: Type.Union([Type.Literal("confirmed"), Type.Literal("potential")]),
    overbookMinutes: Type.Integer(),
    fingerprint: Type.String(),
  },
  { additionalProperties: false },
);
export const PlannerScheduleResponse = Type.Object(
  {
    start: DateOnly,
    end: DateOnly,
    scenario: Type.Union([Type.Literal("confirmed"), Type.Literal("confirmed_and_tentative")]),
    people: Type.Array(
      Type.Object(
        { personId: Uuid, days: Type.Array(DailyCapacityResponse) },
        { additionalProperties: false },
      ),
    ),
    conflicts: Type.Array(ConflictResponse),
  },
  { additionalProperties: false },
);

export const EmptySuccessResponse = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false },
);
export const WorkScheduleResponse = ScheduleResponse;
