import { Type } from "@sinclair/typebox";

const Uuid = Type.String({ format: "uuid" });
const DateOnly = Type.String({ pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" });
const NullableDateTime = Type.Union([Type.String(), Type.Null()]);
const ErrorResponse = Type.Object({ error: Type.String() }, { additionalProperties: false });
export const commonResponses = (
  success: ReturnType<typeof Type.Object> | ReturnType<typeof Type.Array>,
) => ({
  200: success,
  400: ErrorResponse,
  401: ErrorResponse,
  403: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  415: ErrorResponse,
  429: ErrorResponse,
});

export const NamedItemResponse = Type.Object(
  { id: Uuid, name: Type.String(), rowVersion: Type.Integer() },
  { additionalProperties: false },
);
export const NamedListResponse = Type.Array(NamedItemResponse);
export const EmptyResponse = Type.Object(
  { ok: Type.Literal(true) },
  { additionalProperties: false },
);

export const HolidayDateResponse = Type.Object(
  { date: DateOnly, name: Type.String() },
  { additionalProperties: false },
);
export const HolidayCalendarResponse = Type.Object(
  {
    id: Uuid,
    name: Type.String(),
    rowVersion: Type.Integer(),
    dates: Type.Optional(Type.Array(HolidayDateResponse)),
  },
  { additionalProperties: false },
);
export const HolidayCalendarListResponse = Type.Array(HolidayCalendarResponse);

export const LeaveEntryResponse = Type.Object(
  {
    id: Uuid,
    personId: Uuid,
    leaveTypeId: Type.Optional(Uuid),
    leaveTypeName: Type.Optional(Type.String()),
    startDate: DateOnly,
    endDate: DateOnly,
    minutesPerDay: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    rowVersion: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);
export const LeaveListResponse = Type.Array(LeaveEntryResponse);

export const ConflictResponse = Type.Object(
  {
    personId: Uuid,
    date: DateOnly,
    severity: Type.Union([Type.Literal("confirmed"), Type.Literal("potential")]),
    overbookMinutes: Type.Integer(),
    fingerprint: Type.String(),
    source: Type.String(),
    acknowledged: Type.Boolean(),
    acknowledgedBy: Type.Union([Uuid, Type.Null()]),
    acknowledgedAt: NullableDateTime,
  },
  { additionalProperties: false },
);
export const ConflictListResponse = Type.Array(ConflictResponse);

export const EarliestResultResponse = Type.Object(
  {
    personId: Uuid,
    start: DateOnly,
    end: DateOnly,
    minimumHeadroomMinutes: Type.Integer(),
    explanation: Type.String(),
  },
  { additionalProperties: false },
);
export const EarliestListResponse = Type.Array(EarliestResultResponse);

const ForecastWeekResponse = Type.Object(
  {
    weekStart: DateOnly,
    capacityMinutes: Type.Integer(),
    confirmedBillableMinutes: Type.Integer(),
    confirmedInternalMinutes: Type.Integer(),
    tentativeBillableMinutes: Type.Integer(),
    tentativeInternalMinutes: Type.Integer(),
    confirmedUtilizationPercent: Type.Union([Type.Integer(), Type.Null()]),
    potentialUtilizationPercent: Type.Union([Type.Integer(), Type.Null()]),
    confirmedOverbookMinutes: Type.Integer(),
    potentialOverbookMinutes: Type.Integer(),
    billableTargetGapMinutes: Type.Integer(),
  },
  { additionalProperties: false },
);
export const ForecastResponse = Type.Object(
  {
    generatedAt: Type.String(),
    timezone: Type.String(),
    weekStartsOn: Type.Integer(),
    assumptions: Type.String(),
    weeks: Type.Array(ForecastWeekResponse),
  },
  { additionalProperties: false },
);
